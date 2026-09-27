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
	 * Total bytes, and the size of each individual call, `readChangeLogMaxSeq`
	 * reads from `logPath`'s own fd, locked or not. A mutable object — callers
	 * read `.bytesRead`/`.reads` AFTER the read happens, never destructure it
	 * (the count is only correct as a live reference: this closure keeps
	 * mutating the SAME object after the caller's own destructure would have
	 * copied out a stale primitive).
	 */
	function watchReadsOf(): { bytesRead: number; reads: number[] } {
		const state = { bytesRead: 0, reads: [] as number[] };
		const logFds = new Set<number>();
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
					if (logFds.has(args[0] as number)) {
						state.bytesRead += read;
						state.reads.push(read);
					}
					return read;
				}) as typeof real,
		);
		return state;
	}

	/**
	 * Recurrence: #3594 item 2 (#3577 option 3). #3595 (item 1 of #3594's own
	 * batch) took the first-allocation read outside the lock, but left it a
	 * full FORWARD read of the whole log — #3577's evidence measured 0.83-1.17s
	 * at 150 MB. `readChangeLogMaxSeq`'s log has one hard invariant already
	 * pinned by `project-changes-seq-properties.test.ts`'s `monotonicLog`
	 * property: every line's seq is strictly above every line before it. The
	 * log's LAST complete line therefore always carries the true max — no walk
	 * over the lines before it is needed to find it.
	 */
	it("the first allocation scans backward for the last line instead of reading the whole log (#3594 item 2, #3577 option 3)", () => {
		nodeFs.mkdirSync(path.dirname(logPath), { recursive: true });
		let existing = "";
		for (let seq = 1; seq <= 5_000; seq++) existing += logLine(seq);
		nodeFs.writeFileSync(logPath, existing);
		const fileSize = nodeFs.statSync(logPath).size;

		const counts = watchReadsOf();
		const runtime = new RuntimeCoordinator();
		runtime.seedProjectSequence(0); // the timed-out read's cold seed
		expect(edit(runtime, "a.ts").projectSeq).toBe(5_001);
		// A bounded backward scan reads one small window near the end, not the
		// whole file: comfortably under a tenth of it, and under an absolute
		// cap regardless of how large the log grows.
		expect(counts.bytesRead).toBeLessThan(fileSize / 10);
		expect(counts.bytesRead).toBeLessThan(20_000);
	});

	/**
	 * The gate that chooses the tail scan is "nothing of this file accounted
	 * for yet" (`cursor.bytes === 0`), not "the file happens to be large" — so
	 * a SECOND allocation in the same session, already seeded by the first,
	 * must stay on the existing cheap incremental read (only the bytes
	 * appended since), not pay a fresh tail scan on every call.
	 */
	it("a later allocation this session reads only the bytes appended since, not a fresh tail scan (#3594 item 2)", () => {
		nodeFs.mkdirSync(path.dirname(logPath), { recursive: true });
		let existing = "";
		for (let seq = 1; seq <= 5_000; seq++) existing += logLine(seq);
		nodeFs.writeFileSync(logPath, existing);

		const runtime = new RuntimeCoordinator();
		runtime.seedProjectSequence(0);
		expect(edit(runtime, "a.ts").projectSeq).toBe(5_001); // seeds the cursor

		const counts = watchReadsOf();
		expect(edit(runtime, "b.ts").projectSeq).toBe(5_002);
		// Only the one freshly appended line (plus its own second, in-lock
		// read of nothing new) — nowhere near a fresh tail-scan window.
		expect(counts.bytesRead).toBeLessThan(1_000);
	});

	/**
	 * Correctness at the sizes the window-growth loop's own edge lives at: an
	 * empty log, one line, and two lines — the cases where "the window covers
	 * the whole file" (`start === 0`) is reached on the FIRST attempt.
	 */
	it.each([
		["empty log", 0, 1],
		["a single line", 1, 2],
		["two lines", 2, 3],
	])(
		"allocates correctly from %s (#3594 item 2)",
		(_label, seeded, expected) => {
			nodeFs.mkdirSync(path.dirname(logPath), { recursive: true });
			let existing = "";
			for (let seq = 1; seq <= seeded; seq++) existing += logLine(seq);
			nodeFs.writeFileSync(logPath, existing);

			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(0);
			expect(edit(runtime, "a.ts").projectSeq).toBe(expected);
		},
	);

	/**
	 * A single line long enough that the initial 4 KB window does not reach
	 * its own start: `tailMaxSeq` must grow the window (doubling) rather than
	 * mis-read a truncated line or silently fall through to `undefined`
	 * (which would fall back to the full read — correct, but not what this
	 * case is proving).
	 */
	it("allocates correctly when the log's only line is longer than the initial scan window (#3594 item 2)", () => {
		nodeFs.mkdirSync(path.dirname(logPath), { recursive: true });
		// Padded well past a few doublings of the initial window, so a mutant
		// that stops trusting "the window now covers the whole file" (no
		// preceding newline needed once `start === 0`) and instead falls back
		// to a single full-size read reads a size this test can tell apart
		// from a genuine window growth sequence.
		const longPath = path.join(cwd, "src", `${"pad".repeat(20_000)}.ts`);
		nodeFs.writeFileSync(
			logPath,
			`${JSON.stringify({
				seq: 7,
				timestamp: new Date(0).toISOString(),
				sessionId: "older-session",
				turnIndex: 0,
				source: "agent-edit",
				filePath: longPath,
				fileSeq: 7,
			})}\n`,
		);
		const size = nodeFs.statSync(logPath).size;
		expect(size).toBeGreaterThan(32_768);

		const counts = watchReadsOf();
		const runtime = new RuntimeCoordinator();
		runtime.seedProjectSequence(0);
		expect(edit(runtime, "a.ts").projectSeq).toBe(8);
		// The FIRST attempt uses the small initial window, not a single
		// full-size read — proof the growth loop ran rather than the tail
		// scan silently declining and falling back to a plain forward read
		// (which reads the WHOLE size in its one and only call).
		expect(counts.reads[0]).toBeLessThanOrEqual(4_096);
		expect(counts.reads.length).toBeGreaterThan(1);
		// The LAST attempt (window grown to cover the whole file) is accepted
		// on its own: a mutant that stops trusting "no preceding newline is
		// needed once the window covers byte 0" falls through to the OLD
		// full-size fallback read instead, reading the file's full size a
		// SECOND time right after the window already grew to cover it.
		expect(counts.reads.at(-1)).toBe(size);
		expect(counts.reads.filter((n) => n === size)).toHaveLength(1);
	});

	/**
	 * Recurrence: #3594 item 2 round 2 (review, verify). A naive "trust the
	 * LAST complete line's own seq" first version of `tailMaxSeq` shipped and
	 * broke `tests/clients/project-snapshot-cross-process.test.ts`'s "a line
	 * still being written is read once it is complete" — an unlocked
	 * writer's line can finish landing in the log AFTER a lower-seq line an
	 * unseeded reader already appended past it, so the file's own byte order
	 * is not always seq order at the exact moment a cold cursor reads it.
	 * This pins the same shape directly against `tailMaxSeq`'s own seam:
	 * a tiny two-line log where the FIRST line carries the higher seq.
	 */
	it("allocates correctly when an earlier line in the log carries a higher seq than the last (#3594 item 2 round 2)", () => {
		nodeFs.mkdirSync(path.dirname(logPath), { recursive: true });
		// The exact shape an unlocked writer's delayed completion leaves: its
		// higher seq (5) physically precedes a lower seq (1) that landed
		// first because THIS runtime allocated it while the writer's own
		// line was still incomplete.
		nodeFs.writeFileSync(logPath, logLine(5) + logLine(1));

		const counts = watchReadsOf();
		const runtime = new RuntimeCoordinator();
		runtime.seedProjectSequence(0);
		expect(edit(runtime, "a.ts").projectSeq).toBe(6);
		// Trusted directly, in one read — not via a fallback to the OLD
		// full-read algorithm after tailMaxSeq gives up (which would still
		// be correct, but is exactly the cost this optimization exists to
		// avoid: a mutant that stops trusting a window already covering the
		// whole file reds here on read count, not on the allocated value).
		expect(counts.reads).toHaveLength(1);
	});

	/**
	 * Recurrence: same shape as above, scaled so the disordered pair sits
	 * INSIDE the first (small) scan window while the log is still too large
	 * for that window to cover the whole file — the case where trusting the
	 * window's own local max immediately (without checking it against the
	 * window's own last line) would settle for a value that a mutation
	 * could get away with for a single disordered pair, but a genuine fix
	 * must instead keep growing past it rather than stopping the moment ANY
	 * complete line parses.
	 */
	it("keeps growing the window when the disordered pair sits inside it, not just when it stops at one line (#3594 item 2 round 2)", () => {
		nodeFs.mkdirSync(path.dirname(logPath), { recursive: true });
		let existing = "";
		for (let seq = 1; seq <= 200; seq++) existing += logLine(seq);
		existing += logLine(999); // an unlocked writer's reserved-early seq
		existing += logLine(201); // this runtime's own, landed first
		nodeFs.writeFileSync(logPath, existing);
		const size = nodeFs.statSync(logPath).size;
		// The disordered [999, 201] pair must be inside the FIRST window, and
		// the window must NOT yet cover the whole file — otherwise this is
		// the same "start === 0" shape the test above already covers.
		expect(size).toBeGreaterThan(4_096 * 2);

		const counts = watchReadsOf();
		const runtime = new RuntimeCoordinator();
		runtime.seedProjectSequence(0);
		expect(edit(runtime, "a.ts").projectSeq).toBe(1_000);
		// More than one attempt: the first window's own disorder (max 999,
		// last line 201) is not trusted on sight, so the loop grows past it.
		expect(counts.reads.length).toBeGreaterThan(1);
		expect(counts.reads[0]).toBeLessThanOrEqual(4_096);
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
