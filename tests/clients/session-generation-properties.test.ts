/**
 * #3576 (G5, maintainer addition): the session generation guard over the
 * interleavings fast-check's scheduler picks, instead of one replay per
 * interleaving.
 *
 * Recurrence this file prevents: the session-straddle defects of one day
 * (#3499, #3512, #3528, #3568, #3576), each a writer that captured its
 * session, awaited, and landed after the next session's `session_start`.
 * Each was caught by a replay of the interleaving it was written for; the
 * property below states the guard's contract for every interleaving of
 * session starts, session shutdowns and writer completions.
 *
 * Production chain: a REAL `RuntimeCoordinator` and the real writers whose
 * guard takes the captured handle as an argument:
 * - `appendCascadePromise` (#3512: the deferred cascade's admission, then its
 *   compute settles under the scheduler and the turn end's settle appends it);
 * - `deferRunnerFindings` (#3568: a collect-later runner's deferral into the
 *   turn-end store, whose compute also settles under the scheduler);
 * - `recordLspMutation` with a session on its context (#3576: the quickfix
 *   pass's bookkeeping into the change log, the read guard and turn state).
 * A writer captures `runtime.captureSessionGeneration()` when it is issued,
 * awaits its work (a scheduled promise: the pipeline, the formatter, the code
 * action), then writes. `session_start` is the production pair that runs in
 * one tick (`resetPendingRunnerFindings`, then `runtime.resetForSession`,
 * `runtime-session.ts`), and `session_shutdown` is `resetLSPService`, which
 * retires the LSP service and leaves the runtime session alone.
 *
 * The oracle is the test's own: which session each writer was issued in comes
 * from the command log, never from the coordinator's generation.
 *
 * How to write one of these: `tests/support/scheduler-properties.md`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
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
import { CacheManager } from "../../clients/cache-manager.js";
import type { CascadeRun } from "../../clients/cascade-types.js";
import {
	deferRunnerFindings,
	drainPendingRunnerFindings,
	resetPendingRunnerFindings,
} from "../../clients/dispatch/pending-runner-findings.js";
import type { RunnerResult } from "../../clients/dispatch/types.js";
import { recordLspMutation } from "../../clients/lsp-mutation.js";
import { resetLSPService } from "../../clients/lsp/index.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";

/**
 * Budget: a run is microtasks plus one synchronous change-log append per
 * bookkeeping writer; NUM_RUNS take about 1.1 s here (measured). The seed is
 * fixed so the lane is deterministic; raise NUM_RUNS or drop SEED locally to
 * explore. Seeds 1-100 at this NUM_RUNS were green before landing.
 */
const NUM_RUNS = 1000;
const SEED = 3576;
const PROPERTY_TIMEOUT_MS = 20_000;

// --- Generated commands --------------------------------------------------

type WriterKind = "cascade" | "runner" | "bookkeep";
type Command =
	| { t: "write"; kind: WriterKind }
	| { t: "start" }
	| { t: "shutdown" };

const commandArb: fc.Arbitrary<Command> = fc.oneof(
	{
		weight: 6,
		arbitrary: fc.record({
			t: fc.constant("write" as const),
			kind: fc.constantFrom<WriterKind>("cascade", "runner", "bookkeep"),
		}),
	},
	{ weight: 2, arbitrary: fc.constant({ t: "start" as const }) },
	{ weight: 1, arbitrary: fc.constant({ t: "shutdown" as const }) },
);

const commandsArb = fc.array(commandArb, { minLength: 1, maxLength: 8 });

// --- Recorded run --------------------------------------------------------

interface Writer {
	id: number;
	kind: WriterKind;
	/** The file the writer writes; its name identifies the writer. */
	file: string;
	/** The test's own session count when the writer was issued. */
	session: number;
	settled: boolean;
}

interface Run {
	writers: Writer[];
	/** The session count at quiescence. */
	finalSession: number;
	/** Writer files each store holds at quiescence. */
	cascade: string[];
	runner: string[];
	bookkeep: string[];
	log: string[];
	unsettled: string[];
}

let root: string;

async function execute(
	s: fc.Scheduler,
	commands: readonly Command[],
): Promise<Run> {
	const run: Run = {
		writers: [],
		finalSession: 1,
		cascade: [],
		runner: [],
		bookkeep: [],
		log: [],
		unsettled: [],
	};
	const note = (line: string) => run.log.push(line);
	const runtime = new RuntimeCoordinator();
	runtime.projectRoot = root;
	const cacheManager = new CacheManager(false);
	resetPendingRunnerFindings();
	let session = 1;

	const write = (
		writer: Writer,
		handle: ReturnType<RuntimeCoordinator["captureSessionGeneration"]>,
	) => {
		if (writer.kind === "cascade") {
			const computed: CascadeRun = {
				filePath: writer.file,
				result: undefined,
				neighborCount: 0,
				diagnosticCount: 0,
			};
			runtime.appendCascadePromise(
				s.schedule(Promise.resolve(computed), `compute:${writer.id}`),
				handle,
				writer.file,
			);
		} else if (writer.kind === "runner") {
			const result: RunnerResult = {
				status: "succeeded",
				diagnostics: [],
				semantic: "warning",
			};
			deferRunnerFindings({
				filePath: writer.file,
				cwd: root,
				projectRoot: root,
				runnerId: `runner-${writer.id}`,
				markedAtMs: 0,
				promise: s.schedule(Promise.resolve(result), `runner:${writer.id}`),
				session: handle,
			});
		} else {
			recordLspMutation(
				{
					cwd: root,
					correlationId: `3576-property-${writer.id}`,
					tool: "lsp-quickfix",
					source: "autofix",
					runtime,
					cacheManager,
					readGuard: runtime.readGuard,
					session: handle,
					emitSummary: false,
				},
				{
					bookkeep: true,
					results: [
						{
							descriptions: [],
							files: [writer.file],
							operationTotal: 1,
							appliedOperationTotal: 1,
							appliedOperationIndexes: [0],
							operationCounts: {
								textEdits: 1,
								create: 0,
								rename: 0,
								delete: 0,
							},
							fileDetails: [
								{
									filePath: writer.file,
									range: { start: 1, end: 1 },
									importsChanged: false,
								},
							],
						},
					],
				},
			);
		}
	};

	const issueWriter = (kind: WriterKind, id: number) => {
		const writer: Writer = {
			id,
			kind,
			file: path.join(root, `w${id}.ts`),
			session,
			settled: false,
		};
		fs.writeFileSync(writer.file, `export const w${id} = ${id};\n`);
		run.writers.push(writer);
		// The production capture, taken when the writer starts.
		const handle = runtime.captureSessionGeneration();
		note(`issue ${kind} w${id} in session ${session}`);
		void s.schedule(Promise.resolve(), `work:${id}`).then(() => {
			write(writer, handle);
			writer.settled = true;
			note(`write ${kind} w${id} (session now ${session})`);
		});
	};

	const issued = s.scheduleSequence(
		commands.map((command, index) => ({
			label: `cmd${index}`,
			builder: async () => {
				if (command.t === "write") issueWriter(command.kind, index);
				else if (command.t === "start") {
					resetPendingRunnerFindings();
					runtime.resetForSession();
					session += 1;
					note(`session_start -> session ${session}`);
				} else {
					resetLSPService({ reason: "session_shutdown" });
					note("session_shutdown");
				}
			},
		})),
	);

	const unsettled = () =>
		run.writers.filter((w) => !w.settled).map((w) => `w${w.id}`);
	await s.waitFor(issued.task);
	for (
		let round = 0;
		round < 50 && (s.count() > 0 || unsettled().length > 0);
		round++
	)
		await s.waitIdle();
	run.unsettled = unsettled();
	run.finalSession = session;

	// The final session's turn end reads each store.
	await runtime.settleCascadeRuns(0);
	run.cascade = runtime.consumeCascadeRuns().map((r) => r.filePath);
	run.runner = (await drainPendingRunnerFindings(0)).map((e) => e.filePath);
	const bookkept = new Set(runtime.getFileSeqEntries().map(([key]) => key));
	run.bookkeep = run.writers
		.filter((w) => bookkept.has(normalizeMapKey(w.file)))
		.map((w) => w.file);
	return run;
}

// --- The oracle ----------------------------------------------------------

function heldBy(run: Run, kind: WriterKind): string[] {
	return kind === "cascade"
		? run.cascade
		: kind === "runner"
			? run.runner
			: run.bookkeep;
}

/** Every writer settles. */
function liveness(run: Run): string[] {
	return run.unsettled.map((what) => `${what} never wrote`);
}

/**
 * Safety: no writer issued in a superseded session is in the final session's
 * state, whichever order its write and the session starts came in.
 */
function noStaleWrite(run: Run): string[] {
	const out: string[] = [];
	for (const w of run.writers) {
		if (w.session === run.finalSession) continue;
		if (heldBy(run, w.kind).includes(w.file))
			out.push(
				`${w.kind} w${w.id} from session ${w.session} is in session ${run.finalSession}'s state`,
			);
	}
	return out;
}

/**
 * No-drop (shape 54): every writer issued in the final session is in its
 * state, whether or not a session_shutdown retired the LSP service meanwhile.
 */
function noOwnDrop(run: Run): string[] {
	const out: string[] = [];
	for (const w of run.writers) {
		if (w.session !== run.finalSession) continue;
		if (!heldBy(run, w.kind).includes(w.file))
			out.push(`${w.kind} w${w.id} of the final session was dropped`);
	}
	return out;
}

const PROPERTIES = { liveness, noStaleWrite, noOwnDrop } satisfies Record<
	string,
	(run: Run) => string[]
>;
type PropertyName = keyof typeof PROPERTIES;
const ALL = Object.keys(PROPERTIES) as PropertyName[];

function assertHolds(run: Run, names: readonly PropertyName[]): void {
	const found = names.flatMap((name) =>
		PROPERTIES[name](run).map((v) => `${name}: ${v}`),
	);
	if (found.length > 0)
		throw new Error(`${found.join("\n")}\n--- trace\n${run.log.join("\n")}`);
}

describe("#3576 — the session generation guard over scheduled interleavings", () => {
	let previousDataDir: string | undefined;
	beforeAll(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-3576-property-"));
		previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(root, "data");
	});
	afterAll(() => {
		if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = previousDataDir;
		fs.rmSync(root, { recursive: true, force: true });
	});
	beforeEach(() => {
		// Nothing here waits on a timer; fake timers keep any a writer arms from
		// firing into a later run.
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		resetPendingRunnerFindings();
	});

	it(
		"no superseded writer reaches the new session, and no current writer is dropped, for any ordering",
		{ timeout: PROPERTY_TIMEOUT_MS },
		async () => {
			await fc.assert(
				fc.asyncProperty(fc.scheduler(), commandsArb, async (s, commands) => {
					assertHolds(await execute(s, commands), ALL);
				}),
				{ numRuns: NUM_RUNS, seed: SEED },
			);
		},
	);
});
