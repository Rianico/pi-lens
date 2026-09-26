/**
 * #3577 (G4 of #3518): properties of the change-log seq allocator
 * (`appendProjectChangeAllocated`, driven through
 * `RuntimeCoordinator.recordProjectMutation`) over the interleavings
 * fast-check's scheduler picks.
 *
 * Recurrence this file prevents: #3511, two runtimes logging the same seq,
 * and the orderings around it that no replay pins: a session_start read that
 * lands after other runtimes appended (it re-seeds this process's read
 * cursor), a sibling holding the change-log lock (the unlocked fallback and
 * the #3578 skip), and a runtime's own session reset. The PR body quotes the
 * shrunk counterexamples of the seeded allocator mutations.
 *
 * Production chain: the REAL `RuntimeCoordinator` (`recordProjectMutation`,
 * `resetForSession`, `seedProjectSequence`, `mergeProjectSequence`) over the
 * real `project-changes` allocator, its read cursor and the real generation
 * lock, on a real log file. The one await is `fs.promises.readFile` in
 * `readLatestProjectSequenceAsync`, the session_start read: the model reads
 * the log when the read is issued (`early`) or when the scheduler releases it,
 * so the scheduler, not I/O timing, decides when a read lands. Everything
 * else is synchronous, as it is in production: one allocation never
 * interleaves with another inside a process. The lock's backoff sleep advances
 * a fake clock instead of blocking.
 *
 * The session_start driver mirrors `readSequenceWithBudget`'s timed-out
 * branch in `clients/runtime-session.ts`: a cold seed at 0, then a late read
 * that merges into a session that has advanced, or seeds one that has not.
 * A read that lands in time is the same seed with no edit before it.
 *
 * The oracle is the test's own: which command logged which line (appends are
 * serialized, so the log's lines are the logged edits in issue order), what
 * each edit returned, and whether the sibling held the lock at the time.
 *
 * Not a property: gap-free seqs. An unlogged mutation (no `cwd`) bumps a
 * runtime's seq without a log line, so the log has gaps by design.
 *
 * How to write one of these: `tests/support/scheduler-properties.md`.
 */

import nodeFs from "node:fs";
import * as path from "node:path";
import fc from "fast-check";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	it,
	vi,
} from "vitest";
import {
	type GenerationHold,
	releaseGeneration,
	tryAcquireGeneration,
} from "../../clients/generation-lock.js";
import {
	getProjectChangeLogPath,
	readLatestProjectSequenceAsync,
	readProjectChanges,
} from "../../clients/project-changes.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { setupTestEnvironment } from "./test-utils.js";

/**
 * Budget: one run is a handful of synchronous appends and lock-file writes on
 * a temp dir, a few milliseconds; 400 runs took 1.8-2.7 s at load average
 * 12-14 on 4 cores. PROPERTY_TIMEOUT_MS leaves headroom over that. The seed
 * is fixed so the lane is deterministic; raise NUM_RUNS or drop SEED locally
 * to explore. Edits and session starts weigh the same because the cursor
 * regressions need a start, other runtimes' edits and a late read in one run.
 */
const NUM_RUNS = 400;
const SEED = 3577;
const PROPERTY_TIMEOUT_MS = 30_000;
const RUNTIMES = 3;

type Command =
	| { t: "edit"; r: number }
	| { t: "unlogged"; r: number }
	| { t: "start"; r: number; early: boolean }
	| { t: "hold" }
	| { t: "release" };

const runtimeArb = fc.integer({ min: 0, max: RUNTIMES - 1 });
const commandArb: fc.Arbitrary<Command> = fc.oneof(
	{
		weight: 4,
		arbitrary: fc.record({ t: fc.constant("edit" as const), r: runtimeArb }),
	},
	{
		weight: 1,
		arbitrary: fc.record({
			t: fc.constant("unlogged" as const),
			r: runtimeArb,
		}),
	},
	{
		weight: 4,
		arbitrary: fc.record({
			t: fc.constant("start" as const),
			r: runtimeArb,
			early: fc.boolean(),
		}),
	},
	{ weight: 1, arbitrary: fc.constant({ t: "hold" as const }) },
	{ weight: 1, arbitrary: fc.constant({ t: "release" as const }) },
);

// --- Recorded run --------------------------------------------------------

interface Allocation {
	runtime: number;
	/** The runtime's session count when the edit was issued. */
	session: number;
	logged: boolean;
	seq: number;
	/** The sibling held the change-log lock when the edit was issued. */
	lockHeld: boolean;
	command: number;
}

interface Run {
	allocations: Allocation[];
	log: Array<{ seq: number; unlocked: boolean }>;
	unlanded: number;
	trace: string[];
}

let env: ReturnType<typeof setupTestEnvironment>;
let previousDataDir: string | undefined;
let runCount = 0;
const realReadFile = nodeFs.promises.readFile;

async function execute(
	s: fc.Scheduler,
	commands: readonly Command[],
): Promise<Run> {
	const cwd = path.join(env.tmpDir, `run-${++runCount}`);
	const logPath = getProjectChangeLogPath(cwd);
	const run: Run = { allocations: [], log: [], unlanded: 0, trace: [] };
	const note = (line: string) => run.trace.push(line);
	// A fresh clock per run, so the sibling's hold is inside its lease.
	vi.setSystemTime(vi.getRealSystemTime());

	const readLog = (): { content?: string; error?: unknown } => {
		try {
			return { content: nodeFs.readFileSync(logPath, "utf8") };
		} catch (error) {
			return { error };
		}
	};
	let captureEarly = false;
	let pendingReads = 0;
	nodeFs.promises.readFile = ((file: unknown, options: unknown) => {
		if (String(file) !== logPath)
			return (realReadFile as (...a: unknown[]) => Promise<unknown>)(
				file,
				options,
			);
		const early = captureEarly ? readLog() : undefined;
		pendingReads++;
		return s
			.schedule(Promise.resolve(), early ? "read lands (early)" : "read lands")
			.then(() => {
				pendingReads--;
				const read = early ?? readLog();
				if (read.error !== undefined) throw read.error;
				return read.content;
			});
	}) as typeof nodeFs.promises.readFile;

	const runtimes = Array.from(
		{ length: RUNTIMES },
		() => new RuntimeCoordinator(),
	);
	const sessions = runtimes.map(() => 0);
	let hold: GenerationHold | undefined;

	const start = (r: number, early: boolean) => {
		const runtime = runtimes[r]!;
		runtime.resetForSession();
		sessions[r]! += 1;
		const generation = runtime.sessionGeneration;
		// The timed-out read's cold seed.
		runtime.seedProjectSequence(0, new Map(), 0);
		captureEarly = early;
		void readLatestProjectSequenceAsync(cwd).then((latest) => {
			if (!runtime.isCurrentSession(generation)) {
				note(`r${r} read lands after a newer session: dropped`);
				return;
			}
			if (runtime.projectSeq > 0) {
				runtime.mergeProjectSequence(
					latest.projectSeq,
					latest.fileSeqByPath,
					latest.logEntries,
				);
				note(`r${r} read lands: merge ${latest.projectSeq}`);
			} else {
				runtime.seedProjectSequence(
					latest.projectSeq,
					latest.fileSeqByPath,
					latest.logEntries,
				);
				note(`r${r} read lands: seed ${latest.projectSeq}`);
			}
		});
		captureEarly = false;
	};

	const issued = s.scheduleSequence(
		commands.map((command, index) => ({
			label: `cmd${index}:${command.t}${"r" in command ? command.r : ""}`,
			builder: async () => {
				if (command.t === "hold") {
					if (hold) return;
					hold = tryAcquireGeneration(`${logPath}.locks`, 5_000);
					note(hold ? "sibling holds the lock" : "sibling could not hold");
				} else if (command.t === "release") {
					if (!hold) return;
					releaseGeneration(hold);
					hold = undefined;
					note("sibling releases the lock");
				} else if (command.t === "start") {
					note(
						`r${command.r} session start (${command.early ? "early" : "late"} read)`,
					);
					start(command.r, command.early);
				} else {
					const runtime = runtimes[command.r]!;
					const logged = command.t === "edit";
					const lockHeld = hold !== undefined;
					const { projectSeq } = runtime.recordProjectMutation({
						filePath: path.join(cwd, "src", `c${index}.ts`),
						source: "agent-write",
						...(logged ? { cwd } : {}),
						onAppendError: (error) => {
							throw error;
						},
					});
					run.allocations.push({
						runtime: command.r,
						session: sessions[command.r]!,
						logged,
						seq: projectSeq,
						lockHeld,
						command: index,
					});
					note(
						`r${command.r} ${logged ? "edit" : "unlogged"} -> ${projectSeq}${lockHeld ? " (lock held)" : ""}`,
					);
				}
			},
		})),
	);

	await s.waitFor(issued.task);
	for (let round = 0; round < 50 && s.count() > 0; round++) await s.waitIdle();
	run.unlanded = pendingReads;
	if (hold) releaseGeneration(hold);
	run.log = readProjectChanges(cwd).map((entry) => ({
		seq: entry.seq,
		unlocked: entry.unlocked === true,
	}));
	return run;
}

// --- The oracle ----------------------------------------------------------

function logged(run: Run): Allocation[] {
	return run.allocations.filter((a) => a.logged);
}

/** Every read the scheduler was handed landed; every logged edit has a line. */
function liveness(run: Run): string[] {
	const out: string[] = [];
	if (run.unlanded > 0) out.push(`${run.unlanded} session reads never landed`);
	if (run.log.length !== logged(run).length)
		out.push(`${logged(run).length} logged edits, ${run.log.length} lines`);
	return out;
}

/** #3511: no two log lines carry the same seq. */
function uniqueSeqs(run: Run): string[] {
	const seen = new Set<number>();
	const out: string[] = [];
	for (const line of run.log) {
		if (seen.has(line.seq)) out.push(`seq ${line.seq} logged twice`);
		seen.add(line.seq);
	}
	return out;
}

/** Each line's seq is above every line before it. */
function monotonicLog(run: Run): string[] {
	const out: string[] = [];
	for (let i = 1; i < run.log.length; i++)
		if (run.log[i]!.seq <= run.log[i - 1]!.seq)
			out.push(`line ${i} seq ${run.log[i]!.seq} after ${run.log[i - 1]!.seq}`);
	return out;
}

/** The seq an edit returned is the seq its line carries. */
function receiptMatchesLog(run: Run): string[] {
	return logged(run).flatMap((a, i) =>
		run.log[i] && run.log[i]!.seq !== a.seq
			? [`cmd${a.command} returned ${a.seq}, logged ${run.log[i]!.seq}`]
			: [],
	);
}

/** Within one session, a runtime's seqs (logged or not) only rise. */
function sessionMonotonic(run: Run): string[] {
	const out: string[] = [];
	const last = new Map<string, number>();
	for (const a of run.allocations) {
		const key = `r${a.runtime}/s${a.session}`;
		const previous = last.get(key);
		if (previous !== undefined && a.seq <= previous)
			out.push(`${key}: cmd${a.command} got ${a.seq} after ${previous}`);
		last.set(key, a.seq);
	}
	return out;
}

/**
 * #3511 review round 2 and #3578: a line appended while the sibling held
 * the lock is tagged `unlocked`, and one appended while the lock was free is
 * not (a free lock is taken on the first try, even after a skipped wait).
 */
function lockTagging(run: Run): string[] {
	return logged(run).flatMap((a, i) => {
		const line = run.log[i];
		if (!line || line.unlocked === a.lockHeld) return [];
		return [
			`cmd${a.command} (${a.lockHeld ? "lock held" : "lock free"}) logged ${line.unlocked ? "unlocked" : "locked"}`,
		];
	});
}

const PROPERTIES = {
	liveness,
	uniqueSeqs,
	monotonicLog,
	receiptMatchesLog,
	sessionMonotonic,
	lockTagging,
} satisfies Record<string, (run: Run) => string[]>;

function assertHolds(run: Run): void {
	const found = Object.entries(PROPERTIES).flatMap(([name, check]) =>
		check(run).map((v) => `${name}: ${v}`),
	);
	if (found.length > 0)
		throw new Error(
			`${found.join("\n")}\n--- log ${JSON.stringify(run.log)}\n--- trace\n${run.trace.join("\n")}`,
		);
}

describe("#3577 — change-log seq allocation over scheduled interleavings", () => {
	beforeAll(() => {
		env = setupTestEnvironment("project-changes-seq-props-");
		previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
	});
	afterAll(() => {
		if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = previousDataDir;
		env.cleanup();
	});
	beforeEach(() => {
		// The lock's 5-25 ms backoff advances the fake clock instead of
		// blocking; its 500 ms wait then costs no real time.
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.spyOn(Atomics, "wait").mockImplementation(((
			_array: unknown,
			_index: unknown,
			_value: unknown,
			timeout?: number,
		) => {
			vi.setSystemTime(Date.now() + (timeout ?? 0));
			return "timed-out";
		}) as typeof Atomics.wait);
	});
	afterEach(() => {
		nodeFs.promises.readFile = realReadFile;
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it(
		"seqs stay unique, rising and correctly tagged for any command sequence and ordering",
		{ timeout: PROPERTY_TIMEOUT_MS },
		async () => {
			await fc.assert(
				fc.asyncProperty(
					fc.scheduler(),
					fc.array(commandArb, { minLength: 1, maxLength: 10 }),
					async (s, commands) => {
						assertHolds(await execute(s, commands));
					},
				),
				{ numRuns: NUM_RUNS, seed: SEED },
			);
		},
	);

	/**
	 * The read cursor's regression, replayed over every ordering of its
	 * commands: r1's session read captures the log early, r2's read folds
	 * more of it, then r1's lands. The cursor must move back to the end of
	 * r1's read. A cursor that never moves backwards keeps r2's end with r1's
	 * max, hides the line between, and r1's next edit reuses its seq. The
	 * property above finds that at 8 of seeds 1-20 at its budget; this pins it.
	 */
	it("a session read that captured the log early never hides lines a later read folded", async () => {
		const commands: Command[] = [
			{ t: "edit", r: 0 },
			{ t: "start", r: 1, early: true },
			{ t: "edit", r: 0 },
			{ t: "start", r: 2, early: false },
			{ t: "edit", r: 1 },
		];
		await fc.assert(
			fc.asyncProperty(fc.scheduler(), async (s) => {
				assertHolds(await execute(s, commands));
			}),
			{ numRuns: 100, seed: SEED },
		);
	});
});
