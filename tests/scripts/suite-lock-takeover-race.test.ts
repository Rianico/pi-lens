/**
 * #3516: a stale test-suite lock is taken over by exactly one taker.
 *
 * `scripts/lib/suite-lock.mjs` removed a stale lock (or shared slot) by path.
 * Two takers that both judged the same dead holder stale could each remove
 * it, and the later removal deleted the earlier taker's fresh lock: both
 * entered, and two full suites ran at once (the #3476 shape). A stale lock is
 * now removed only by the winner of a takeover (an exclusive create of the
 * next generation in `<lock>.takeover/`), after it reads the file again.
 *
 * The race cases build their interleaving on the real lock code. The two
 * takers run in this process; the seam is `node:fs/promises`, which
 * suite-lock.mjs imports as the same module object this file spies on. A
 * second removal of the lock path always waits until one taker has entered.
 * Every gate releases on a later event of the other taker, never on a clock.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	acquireSharedSlot,
	acquireTestLock,
	getSlotPath,
} from "../../scripts/lib/suite-lock.mjs";
import { waitFor } from "../clients/interleaving-kit.js";

// A PID this large cannot exist on any real system.
const DEAD_PID = 999_999_999;
const FAST = { pollIntervalMs: 5, heartbeatIntervalMs: 0 } as const;

let tmpDir: string;
let lockPath: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lock-race-"));
	lockPath = path.join(tmpDir, "test-suite.lock");
});

afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeOwner(file: string, pid: number): void {
	fs.writeFileSync(
		file,
		JSON.stringify({ pid, startedIso: new Date().toISOString() }),
	);
}

/** A promise with its resolver. */
function gate(): { opened: Promise<void>; open: () => void } {
	let open!: () => void;
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

interface Interleaving {
	/**
	 * With 2, the first four reads of the lock file are held in pairs, each
	 * until the other taker's read arrives: the first pair is both takers
	 * judging the dead holder stale; the second is the re-read before removal,
	 * when both reach it.
	 */
	readPairs: 0 | 2;
	/** Start the second taker only once the first has read the lock file. */
	staggered?: boolean;
	/**
	 * The first taker's first read returns its content (the dead holder) only
	 * once the other taker has entered: it acts on a verdict that went stale.
	 */
	firstReadWaitsForEntry?: boolean;
}

/**
 * Two takers of `target`, which holds a dead owner's lock. Resolves once one
 * taker has entered and the other has either entered too or logged another
 * wait after that, i.e. it saw the entered taker's lock and waited.
 */
type Acquire = (
	log: (message: string) => void,
) => Promise<{ release: () => Promise<void> }>;

async function raceTwoTakers(
	target: string,
	acquire: [Acquire, Acquire],
	interleaving: Interleaving,
): Promise<{ entered: number; releaseAll: () => Promise<void> }> {
	const firstEntered = gate();
	const readFile = fsp.readFile.bind(fsp);
	const unlink = fsp.unlink.bind(fsp);
	const pairs = [gate(), gate()];
	const firstRead = gate();
	let reads = 0;
	let targetReads = 0;
	vi.spyOn(fsp, "readFile").mockImplementation((async (
		...args: Parameters<typeof fsp.readFile>
	) => {
		// Read first, then wait: both takers of a pair see the same content.
		const content = await readFile(...args);
		if (args[0] !== target) return content;
		targetReads += 1;
		if (targetReads === 1) {
			firstRead.open();
			if (interleaving.firstReadWaitsForEntry) await firstEntered.opened;
		}
		if (reads < interleaving.readPairs * 2) {
			const pair = pairs[Math.floor(reads / 2)];
			reads += 1;
			if (reads % 2 === 0) pair.open();
			await pair.opened;
		}
		return content;
	}) as typeof fsp.readFile);
	let unlinks = 0;
	vi.spyOn(fsp, "unlink").mockImplementation((async (
		...args: Parameters<typeof fsp.unlink>
	) => {
		if (args[0] === target) {
			unlinks += 1;
			if (unlinks > 1) await firstEntered.opened;
		}
		return unlink(...args);
	}) as typeof fsp.unlink);

	const held: Array<{ release: () => Promise<void> }> = [];
	const logs: string[][] = [[], []];
	// The taker that did not enter first, and how often it had waited then.
	let other = -1;
	let otherWaitsAtFirstEntry = 0;
	const start = (index: number) =>
		acquire[index]((message) => logs[index].push(message)).then((lock) => {
			held.push(lock);
			if (held.length === 1) {
				other = 1 - index;
				otherWaitsAtFirstEntry = logs[other].length;
				firstEntered.open();
			}
			return lock;
		});
	const first = start(0);
	const takers = [
		first,
		interleaving.staggered ? firstRead.opened.then(() => start(1)) : start(1),
	];
	await waitFor(
		() => ({
			entered: held.length,
			otherWaits: other === -1 ? 0 : logs[other].length,
		}),
		(state) =>
			state.entered === 2 ||
			(state.entered === 1 && state.otherWaits > otherWaitsAtFirstEntry),
	);
	return {
		entered: held.length,
		releaseAll: async () => {
			vi.restoreAllMocks();
			// The entered taker first: the other enters only once it has gone.
			for (const lock of held) await lock.release();
			for (const taker of takers) await (await taker).release();
		},
	};
}

const exclusive = (log: (message: string) => void) =>
	acquireTestLock({ lockPath, slots: 1, ...FAST, log });
const sharedSlot = (log: (message: string) => void) =>
	acquireSharedSlot({ lockPath, slots: 1, ...FAST, log });

describe("suite lock: two takers of one dead holder (#3516)", () => {
	it("lets only one taker into the exclusive lock", async () => {
		writeOwner(lockPath, DEAD_PID);
		const race = await raceTwoTakers(lockPath, [exclusive, exclusive], {
			readPairs: 2,
		});
		try {
			expect(race.entered).toBe(1);
		} finally {
			await race.releaseAll();
		}
	});

	it("lets only one taker into a shared slot", async () => {
		const slotPath = getSlotPath(lockPath, 0);
		writeOwner(slotPath, DEAD_PID);
		const race = await raceTwoTakers(slotPath, [sharedSlot, sharedSlot], {
			readPairs: 2,
		});
		try {
			expect(race.entered).toBe(1);
		} finally {
			await race.releaseAll();
		}
	});

	it("a shared taker does not delete an exclusive taker's fresh lock", async () => {
		// The shared taker reads the dead exclusive holder, then the exclusive
		// taker takes over and enters before the shared taker acts.
		writeOwner(lockPath, DEAD_PID);
		const race = await raceTwoTakers(lockPath, [sharedSlot, exclusive], {
			readPairs: 0,
			staggered: true,
			firstReadWaitsForEntry: true,
		});
		try {
			expect(race.entered).toBe(1);
		} finally {
			await race.releaseAll();
		}
	});
});

describe("suite lock: the takeover generations (#3516)", () => {
	const takeoverDir = () => `${lockPath}.takeover`;

	it("takes over after a taker died holding the takeover", async () => {
		writeOwner(lockPath, DEAD_PID);
		fs.mkdirSync(takeoverDir());
		writeOwner(path.join(takeoverDir(), "lock.1"), DEAD_PID);

		const lock = await acquireTestLock({
			lockPath,
			slots: 1,
			...FAST,
			timeoutMs: 5_000,
		});
		try {
			expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid).toBe(
				process.pid,
			);
		} finally {
			await lock.release();
		}
	});

	it("backs off a takeover generation created from a stale listing", async () => {
		// Another live taker holds generation 3. This taker's listing predates
		// generation 3 and a cleanup that removed 2, so its create of 2
		// succeeds; the listing after the create must show it is not the top.
		writeOwner(lockPath, DEAD_PID);
		fs.mkdirSync(takeoverDir());
		writeOwner(path.join(takeoverDir(), "lock.3"), process.ppid);
		const readdir = fsp.readdir.bind(fsp);
		let listings = 0;
		vi.spyOn(fsp, "readdir").mockImplementation((async (
			...args: Parameters<typeof fsp.readdir>
		) => {
			if (args[0] === takeoverDir() && listings++ === 0)
				return ["lock.1", "lock.1.released"];
			return readdir(...args);
		}) as typeof fsp.readdir);

		await expect(
			acquireTestLock({ lockPath, slots: 1, ...FAST, timeoutMs: 100 }),
		).rejects.toThrow(/timed out after 100ms waiting for test-suite lock/);
		expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid).toBe(DEAD_PID);
	});

	it("takes over past released generations and keeps only the newest two", async () => {
		writeOwner(lockPath, DEAD_PID);
		fs.mkdirSync(takeoverDir());
		// Generations this live process released: released, not held.
		for (const generation of [1, 2, 3]) {
			writeOwner(path.join(takeoverDir(), `lock.${generation}`), process.pid);
			fs.writeFileSync(
				path.join(takeoverDir(), `lock.${generation}.released`),
				"",
			);
		}

		const lock = await acquireTestLock({
			lockPath,
			slots: 1,
			...FAST,
			timeoutMs: 5_000,
		});
		try {
			expect(fs.readdirSync(takeoverDir()).sort()).toEqual([
				"lock.3",
				"lock.3.released",
				"lock.4",
				"lock.4.released",
			]);
		} finally {
			await lock.release();
		}
	});
});
