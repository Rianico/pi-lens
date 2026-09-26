import nodeFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	releaseGeneration,
	tryAcquireGeneration,
} from "../../clients/generation-lock.js";
import {
	appendProjectChange,
	getProjectChangeLogPath,
	getSequenceFoldCountForTests,
	type ProjectSequenceBase,
	type ProjectSequenceIndex,
	readChangesSince,
	readLatestProjectSequence,
	readProjectChanges,
	resetSequenceFoldCountForTests,
} from "../../clients/project-changes.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { setupTestEnvironment } from "./test-utils.js";

describe("project change sequence", () => {
	it("bumps project and file sequences independently", () => {
		const runtime = new RuntimeCoordinator();
		const first = runtime.bumpFileSeq("src/a.ts");
		const second = runtime.bumpFileSeq("src/a.ts");
		const third = runtime.bumpFileSeq("src/b.ts");

		// bumpFileSeq returns the normalized key it recorded under (#2000
		// phase 1) so callers reuse it instead of paying realpath twice.
		expect(first.projectSeq).toBe(1);
		expect(first.fileSeq).toBe(1);
		expect(first.key).toBe(normalizeMapKey(path.resolve("src/a.ts")));
		expect(second).toMatchObject({ projectSeq: 2, fileSeq: 2 });
		expect(third).toMatchObject({ projectSeq: 3, fileSeq: 1 });
		expect(runtime.projectSeq).toBe(3);
		expect(runtime.getFileSeq("src/a.ts")).toBe(2);
		expect(runtime.getFileSeq("src/b.ts")).toBe(1);
	});

	it("persists append-only changes and reads changes since a sequence", () => {
		const env = setupTestEnvironment("project-changes-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const cwd = path.join(env.tmpDir, "project");
			const firstFile = path.join(cwd, "src", "a.ts");
			const secondFile = path.join(cwd, "src", "b.ts");

			appendProjectChange(cwd, {
				seq: 1,
				timestamp: "2026-01-01T00:00:00.000Z",
				sessionId: "s1",
				turnIndex: 1,
				source: "agent-edit",
				filePath: firstFile,
				fileSeq: 1,
				changedRange: { start: 3, end: 5 },
			});
			appendProjectChange(cwd, {
				seq: 2,
				timestamp: "2026-01-01T00:00:01.000Z",
				sessionId: "s1",
				turnIndex: 1,
				source: "format",
				filePath: firstFile,
				fileSeq: 2,
			});
			appendProjectChange(cwd, {
				seq: 3,
				timestamp: "2026-01-01T00:00:02.000Z",
				sessionId: "s2",
				turnIndex: 1,
				source: "agent-write",
				filePath: secondFile,
				fileSeq: 1,
			});

			expect(getProjectChangeLogPath(cwd)).toContain("change-log.jsonl");
			expect(readChangesSince(cwd, 1).map((entry) => entry.seq)).toEqual([
				2, 3,
			]);
			const latest = readLatestProjectSequence(cwd);
			expect(latest.projectSeq).toBe(3);
			expect(latest.fileSeqByPath.get(firstFile.replace(/\\/g, "/"))).toBe(2);
			expect(latest.fileSeqByPath.get(secondFile.replace(/\\/g, "/"))).toBe(1);
		} finally {
			if (previousDataDir === undefined) {
				delete process.env.PILENS_DATA_DIR;
			} else {
				process.env.PILENS_DATA_DIR = previousDataDir;
			}
			env.cleanup();
		}
	});
});

// #1019: the snapshot-bounded partial replay MUST be byte-identical to a full
// replay for the same log state, and must fall back to a full replay for
// legacy/ahead/missing bases. These tests are the primary correctness proof —
// the partial path runs on the interactive session-start critical path.
describe("readLatestProjectSequence partial replay (#1019)", () => {
	let env: ReturnType<typeof setupTestEnvironment>;
	let previousDataDir: string | undefined;
	let cwd: string;

	// OS-agnostic file paths under the isolated tmp dir; assertions never bake in
	// a separator (keys are compared structurally as whole strings).
	const fileA = () => path.join(cwd, "src", "a.ts");
	const fileB = () => path.join(cwd, "src", "b.ts");
	const fileC = () => path.join(cwd, "src", "nested", "c.ts");

	function append(
		seq: number,
		filePath: string,
		fileSeq: number,
		source: "agent-edit" | "external" | "format" = "agent-edit",
	): void {
		appendProjectChange(cwd, {
			seq,
			timestamp: new Date(seq * 1000).toISOString(),
			sessionId: "s",
			turnIndex: 0,
			source,
			filePath,
			fileSeq,
		});
	}

	/** Structural, order-independent view for equality assertions. */
	function shape(index: ProjectSequenceIndex): {
		projectSeq: number;
		files: Array<[string, number]>;
	} {
		return {
			projectSeq: index.projectSeq,
			files: [...index.fileSeqByPath.entries()].sort((a, b) =>
				a[0].localeCompare(b[0]),
			),
		};
	}

	/**
	 * Build a base exactly as production would: the derived index of the log AS
	 * OF seq `sinceSeq`. We read the log after appending only the entries up to
	 * `sinceSeq`, which is precisely what the runtime holds (and stamps into the
	 * snapshot) at that seq.
	 */
	function baseAsOf(sinceSeq: number): ProjectSequenceBase {
		const idx = readLatestProjectSequence(cwd);
		return {
			projectSeq: idx.projectSeq,
			fileSeqByPath: [...idx.fileSeqByPath.entries()],
			sinceSeq,
		};
	}

	beforeEach(() => {
		env = setupTestEnvironment("project-changes-partial-");
		previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		cwd = path.join(env.tmpDir, "project");
	});

	afterEach(() => {
		if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = previousDataDir;
		env.cleanup();
	});

	it("no new entries since S: partial == full (both == base)", () => {
		append(1, fileA(), 1);
		append(2, fileA(), 2);
		append(3, fileB(), 1);
		const base = baseAsOf(3);

		const full = readLatestProjectSequence(cwd);
		const partial = readLatestProjectSequence(cwd, base);
		expect(shape(partial)).toEqual(shape(full));
		expect(partial.projectSeq).toBe(3);
	});

	it("new entries for new + existing files: partial == full", () => {
		append(1, fileA(), 1);
		append(2, fileB(), 1);
		const base = baseAsOf(2);
		// existing file bumped + a brand-new file appears after S
		append(3, fileA(), 2);
		append(4, fileC(), 1);

		const full = readLatestProjectSequence(cwd);
		const partial = readLatestProjectSequence(cwd, base);
		expect(shape(partial)).toEqual(shape(full));
		expect(partial.projectSeq).toBe(4);
	});

	it("a file deleted/last-touched since S: partial == full", () => {
		append(1, fileA(), 1);
		append(2, fileB(), 1);
		append(3, fileC(), 1);
		const base = baseAsOf(3);
		// a later 'external' delete-style change bumps fileB's seq; the fold keeps
		// the max, so the key persists — partial must reproduce that exactly.
		append(4, fileB(), 2, "external");

		const full = readLatestProjectSequence(cwd);
		const partial = readLatestProjectSequence(cwd, base);
		expect(shape(partial)).toEqual(shape(full));
		expect(partial.projectSeq).toBe(4);
	});

	it("empty log: partial (base at seq 0) == full == empty", () => {
		const base: ProjectSequenceBase = {
			projectSeq: 0,
			fileSeqByPath: [],
			sinceSeq: 0,
		};
		const full = readLatestProjectSequence(cwd);
		const partial = readLatestProjectSequence(cwd, base);
		expect(shape(full)).toEqual({ projectSeq: 0, files: [] });
		expect(shape(partial)).toEqual(shape(full));
	});

	it("gaps / out-of-order entries after S: partial == full", () => {
		append(1, fileA(), 1);
		append(3, fileB(), 1); // gap: no seq 2
		const base = baseAsOf(3);
		// deliberately append out of seq order, and with a gap
		append(6, fileC(), 1);
		append(5, fileA(), 2);

		const full = readLatestProjectSequence(cwd);
		const partial = readLatestProjectSequence(cwd, base);
		expect(shape(partial)).toEqual(shape(full));
		expect(partial.projectSeq).toBe(6);
	});

	it("legacy snapshot (no base) folds the full log", () => {
		append(1, fileA(), 1);
		append(2, fileB(), 1);
		const full = readLatestProjectSequence(cwd);
		// undefined base is the legacy path — identical to a full replay.
		const legacy = readLatestProjectSequence(cwd, undefined);
		expect(shape(legacy)).toEqual(shape(full));
		expect(legacy.projectSeq).toBe(2);
	});

	it("snapshot seq AHEAD of log: falls back to full replay (never serves the stale seq)", () => {
		append(1, fileA(), 1);
		append(2, fileB(), 1);
		// A base whose sinceSeq is beyond the log's max seq (log truncated/rotated
		// below the snapshot, or snapshot ahead). Its bogus contents must be
		// ignored in favor of the real log.
		const aheadBase: ProjectSequenceBase = {
			projectSeq: 99,
			fileSeqByPath: [["/bogus/ghost.ts", 42]],
			sinceSeq: 99,
		};
		const full = readLatestProjectSequence(cwd);
		const guarded = readLatestProjectSequence(cwd, aheadBase);
		expect(shape(guarded)).toEqual(shape(full));
		expect(guarded.projectSeq).toBe(2);
		expect(
			[...guarded.fileSeqByPath.keys()].some((k) => k.includes("ghost")),
		).toBe(false);
	});

	it("bounds the work: partial folds strictly FEWER entries than full", () => {
		for (let seq = 1; seq <= 18; seq++) {
			append(seq, seq % 2 === 0 ? fileA() : fileB(), Math.ceil(seq / 2));
		}
		const base = baseAsOf(18);
		append(19, fileA(), 10);
		append(20, fileC(), 1);

		resetSequenceFoldCountForTests();
		readLatestProjectSequence(cwd);
		const fullFolds = getSequenceFoldCountForTests();

		resetSequenceFoldCountForTests();
		readLatestProjectSequence(cwd, base);
		const partialFolds = getSequenceFoldCountForTests();

		// full replays every entry (20); partial folds only the 2 with seq > 18.
		expect(fullFolds).toBe(20);
		expect(partialFolds).toBe(2);
		expect(partialFolds).toBeLessThan(fullFolds);
	});
});

describe("change-log allocation and its lock (#3577, #3578)", () => {
	let env: ReturnType<typeof setupTestEnvironment>;
	let previousDataDir: string | undefined;
	let cwd: string;
	let logPath: string;
	const restores: Array<() => void> = [];

	beforeEach(() => {
		env = setupTestEnvironment("project-changes-lock-");
		previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		cwd = path.join(env.tmpDir, "project");
		logPath = getProjectChangeLogPath(cwd);
		resetDegradationLedger();
	});

	afterEach(() => {
		for (const restore of restores.splice(0).reverse()) restore();
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetDegradationLedger();
		if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = previousDataDir;
		env.cleanup();
	});

	function logLine(seq: number): string {
		return `${JSON.stringify({
			seq,
			timestamp: new Date(0).toISOString(),
			sessionId: "older-session",
			turnIndex: 0,
			source: "agent-edit",
			filePath: path.join(cwd, "src", "old.ts"),
			fileSeq: seq,
		})}\n`;
	}

	function edit(runtime: RuntimeCoordinator, name: string) {
		return runtime.recordProjectMutation({
			filePath: path.join(cwd, "src", name),
			source: "agent-write",
			cwd,
		});
	}

	/** Patch one node:fs function for this test, as its ESM importers see it. */
	function patchFs<
		K extends "writeFileSync" | "openSync" | "readSync" | "readFileSync",
	>(name: K, wrap: (real: (typeof nodeFs)[K]) => (typeof nodeFs)[K]): void {
		const real = nodeFs[name];
		nodeFs[name] = wrap(real);
		syncBuiltinESMExports();
		restores.push(() => {
			nodeFs[name] = real;
			syncBuiltinESMExports();
		});
	}

	/** Watch the change-log lock's generation files being created and released. */
	function watchChangeLogLock(onAcquire: () => void, onRelease: () => void) {
		const prefix = path.join(`${logPath}.locks`, "lock.");
		patchFs(
			"writeFileSync",
			(real) =>
				((...args: Parameters<typeof real>) => {
					const file = String(args[0]);
					const ours = file.startsWith(prefix);
					const release = ours && file.endsWith(".released");
					if (ours && !release) onAcquire();
					const result = real(...args);
					if (release) onRelease();
					return result;
				}) as typeof real,
		);
	}

	/**
	 * Recurrence: #3577. The first logged edit after a timed-out session_start
	 * read has no cursor, and read the whole log while holding the change-log
	 * lock (0.9 s at 150 MB), long enough to push siblings past their wait.
	 */
	it("the first allocation reads the existing log before it takes the lock (#3577)", () => {
		nodeFs.mkdirSync(path.dirname(logPath), { recursive: true });
		let existing = "";
		for (let seq = 1; seq <= 200; seq++) existing += logLine(seq);
		nodeFs.writeFileSync(logPath, existing);

		let held = false;
		let bytesReadUnderLock = 0;
		const logFds = new Set<number>();
		watchChangeLogLock(
			() => {
				held = true;
			},
			() => {
				held = false;
			},
		);
		patchFs(
			"openSync",
			(real) =>
				((...args: Parameters<typeof real>) => {
					const fd = real(...args);
					if (String(args[0]) === logPath) logFds.add(fd);
					return fd;
				}) as typeof real,
		);
		patchFs(
			"readSync",
			(real) =>
				((...args: Parameters<typeof real>) => {
					const read = (real as (...a: unknown[]) => number)(...args);
					if (held && logFds.has(args[0] as number)) bytesReadUnderLock += read;
					return read;
				}) as typeof real,
		);

		const runtime = new RuntimeCoordinator();
		runtime.seedProjectSequence(0); // the timed-out read's cold seed
		expect(edit(runtime, "a.ts").projectSeq).toBe(201);
		expect(bytesReadUnderLock).toBe(0);
	});

	/**
	 * Recurrence: an allocator that trusts the read taken before the lock. A
	 * sibling that held the lock appended in between, and would share its seq.
	 */
	it("a line a sibling appends before this allocation takes the lock is still counted (#3577)", () => {
		nodeFs.mkdirSync(path.dirname(logPath), { recursive: true });
		nodeFs.writeFileSync(logPath, logLine(1) + logLine(2));
		let armed = true;
		watchChangeLogLock(
			() => {
				if (!armed) return;
				armed = false;
				nodeFs.appendFileSync(logPath, logLine(9));
			},
			() => {},
		);
		const runtime = new RuntimeCoordinator();
		runtime.seedProjectSequence(0);
		expect(edit(runtime, "a.ts").projectSeq).toBe(10);
		expect(readProjectChanges(cwd).map((entry) => entry.seq)).toEqual([
			1, 2, 9, 10,
		]);
	});

	/**
	 * Fake time: each backoff sleep advances the fake clock the lock's
	 * deadline reads, instead of blocking. `slept` is the time the main
	 * thread would have been blocked.
	 */
	function fakeBackoff(): { slept: number } {
		const backoff = { slept: 0 };
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.spyOn(Atomics, "wait").mockImplementation(((
			_array: unknown,
			_index: unknown,
			_value: unknown,
			timeout?: number,
		) => {
			backoff.slept += timeout ?? 0;
			vi.setSystemTime(Date.now() + (timeout ?? 0));
			return "timed-out";
		}) as typeof Atomics.wait);
		return backoff;
	}

	function holdChangeLogLock() {
		const hold = tryAcquireGeneration(`${logPath}.locks`, 5_000);
		if (!hold) throw new Error("the change-log lock is not free");
		return hold;
	}

	/**
	 * Recurrence: #3578. Every call waited afresh on a holder an earlier wait
	 * had already run out on: ten logged edits blocked the main thread 5 s.
	 */
	it("ten logged edits under a stuck holder wait once, and every entry is tagged unlocked (#3578)", () => {
		const backoff = fakeBackoff();
		const hold = holdChangeLogLock();
		const runtime = new RuntimeCoordinator();
		for (let i = 0; i < 10; i++) edit(runtime, `e${i}.ts`);
		releaseGeneration(hold);

		expect(backoff.slept).toBeGreaterThanOrEqual(500);
		expect(backoff.slept).toBeLessThan(1_000);
		expect(readProjectChanges(cwd).map((entry) => entry.unlocked)).toEqual(
			Array(10).fill(true),
		);
		const rows = getDegradationSummary();
		expect(rows).toContainEqual(
			expect.objectContaining({
				kind: "generation-lock-wait-skipped",
				count: 1,
			}),
		);
		expect(rows).toContainEqual(
			expect.objectContaining({
				kind: "change-log-lock-unavailable",
				count: 10,
			}),
		);
	});

	it("a new holder after the stuck one gets the full wait again (#3578)", () => {
		const backoff = fakeBackoff();
		const runtime = new RuntimeCoordinator();
		const stuck = holdChangeLogLock();
		edit(runtime, "a.ts");
		releaseGeneration(stuck);
		const next = holdChangeLogLock();
		const before = backoff.slept;
		edit(runtime, "b.ts");
		releaseGeneration(next);
		expect(backoff.slept - before).toBeGreaterThanOrEqual(500);
	});

	it("a first wait is never skipped, even when the holder's generation file cannot be read (#3578)", () => {
		const backoff = fakeBackoff();
		const hold = holdChangeLogLock();
		const prefix = path.join(`${logPath}.locks`, "lock.");
		patchFs(
			"readFileSync",
			(real) =>
				((...args: Parameters<typeof real>) => {
					if (String(args[0]).startsWith(prefix))
						throw Object.assign(new Error("EACCES: permission denied"), {
							code: "EACCES",
						});
					return real(...args);
				}) as typeof real,
		);
		edit(new RuntimeCoordinator(), "a.ts");
		releaseGeneration(hold);
		expect(backoff.slept).toBeGreaterThanOrEqual(500);
	});

	it("once the stuck holder releases, the next edit takes the lock on its first try (#3578)", () => {
		const backoff = fakeBackoff();
		const runtime = new RuntimeCoordinator();
		const stuck = holdChangeLogLock();
		edit(runtime, "a.ts");
		releaseGeneration(stuck);
		const before = backoff.slept;
		edit(runtime, "b.ts");
		expect(backoff.slept).toBe(before);
		expect(readProjectChanges(cwd).map((entry) => entry.unlocked)).toEqual([
			true,
			undefined,
		]);
	});
});
