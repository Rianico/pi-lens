/**
 * #3498: this process's `instances.json` entry across a session replacement.
 *
 * pi's `switchSession` keeps the process and rebuilds the runtime in the
 * resumed session's cwd, so session 1 (root A) ends and session 2 (root B)
 * starts in one process. The registry tail and the registration intent are
 * process singletons and carry over. Each case replays one counterexample of
 * the `SessionRegistry` model (`formal/session-registry/`) on the real
 * registry, the real generation lock and a temp registry directory:
 *
 * - own hold: shutdown lands while this process's heartbeat holds the lock;
 * - late landing: a registration waiting on a peer's lock lands after
 *   shutdown removed the entry;
 * - stale intent: a registration queued before shutdown starts after it,
 *   points the heartbeat's repair at the ended root, and the live root is
 *   never repaired;
 * - peer hold: a peer holds the lock past the sync wait and one async wait.
 *
 * "A peer" is a pre-#3476 lock file owned by this worker's parent, a live pid
 * that is not this process: the generation holder backs off while it exists.
 * `getGlobalPiLensDir` points at a per-test temp dir, so nothing here touches
 * the real `~/.pi-lens/instances.json`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeFilePath } from "../../clients/path-utils.js";
import { waitFor } from "./interleaving-kit.js";
import { removeTempDirSync } from "./test-utils.js";

let dir: string;

vi.mock("../../clients/file-utils.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/file-utils.js")>()),
	getGlobalPiLensDir: () => dir,
}));

const ROOT_A = "/repo/session-1";
const ROOT_B = "/repo/session-2";
/** A declined secondary's root (#2130), served beside session 1's. */
const ROOT_SECONDARY = "/repo/temp-sub";

type Registry = typeof import("../../clients/instance-registry.js");
type Ledger = typeof import("../../clients/degradation-ledger.js");

let registry: Registry;
let ledger: Ledger;

function registryFilePath(): string {
	return path.join(dir, "instances.json");
}

function peerLockPath(): string {
	return `${registryFilePath()}.lock`;
}

/** A live writer that is not this process takes the registry lock. */
function peerHolds(ageMs = 0): void {
	fs.writeFileSync(peerLockPath(), `${process.ppid} ${Date.now()}\n`);
	if (ageMs > 0) {
		const at = new Date(Date.now() - ageMs);
		fs.utimesSync(peerLockPath(), at, at);
	}
}

function peerReleases(): void {
	fs.rmSync(peerLockPath(), { force: true });
}

/** This process's entry, or undefined when it has none. */
function ownEntry():
	| { projectRoot: string; projectRoots: string[] }
	| undefined {
	if (!fs.existsSync(registryFilePath())) return undefined;
	const file = JSON.parse(fs.readFileSync(registryFilePath(), "utf8")) as {
		instances: Array<{
			pid: number;
			projectRoot: string;
			projectRoots: string[];
		}>;
	};
	return file.instances.find((entry) => entry.pid === process.pid);
}

function degradationCount(kind: string): number {
	return (
		ledger.getDegradationSummary().find((group) => group.kind === kind)
			?.count ?? 0
	);
}

/** Session 2 starts in root B; its entry must hold B alone. */
async function expectSessionTwoRegistersAlone(): Promise<void> {
	await registry.registerInstance(ROOT_B);
	expect(ownEntry()).toMatchObject({
		projectRoot: normalizeFilePath(ROOT_B),
		projectRoots: [normalizeFilePath(ROOT_B)],
	});
}

describe("instance registry across a session replacement (#3498)", () => {
	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-instreg-3498-"));
		vi.resetModules();
		registry = await import("../../clients/instance-registry.js");
		ledger = await import("../../clients/degradation-ledger.js");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		peerReleases();
		// The tail is a process singleton: settle it here so nothing queued by
		// one case lands in the next case's directory.
		await registry._settleRegistryMutationsForTests();
		removeTempDirSync(dir);
	});

	/**
	 * session_shutdown arrives while the heartbeat's read of the registry is in
	 * flight, i.e. while the heartbeat holds the registry lock. The sync
	 * removal cannot take a lock this process holds.
	 */
	async function shutdownDuringHeartbeat(): Promise<void> {
		const readFile = fs.promises.readFile.bind(fs.promises);
		let shutdownRan = false;
		vi.spyOn(fs.promises, "readFile").mockImplementation((async (
			...args: Parameters<typeof fs.promises.readFile>
		) => {
			if (!shutdownRan && args[0] === registryFilePath()) {
				shutdownRan = true;
				registry.deregisterInstance();
			}
			return readFile(...args);
		}) as typeof fs.promises.readFile);
		await registry.updateHeartbeat();
		vi.restoreAllMocks();
		await registry._settleRegistryMutationsForTests();
		expect(shutdownRan).toBe(true);
	}

	it("removes the entry when shutdown lands while this process's heartbeat holds the lock", async () => {
		await registry.registerInstance(ROOT_A);
		await shutdownDuringHeartbeat();

		expect(ownEntry()).toBeUndefined();
		expect(degradationCount("instance-registry-lock-timeout")).toBe(1);
		expect(
			ledger
				.getDegradationSummary()
				.find((group) => group.kind === "instance-registry-deregister-queued")
				?.latestReasons[0]?.reason,
		).toMatch(/queued behind the holder/);
		expect(degradationCount("instance-registry-deregister-landed")).toBe(1);
		await expectSessionTwoRegistersAlone();
	});

	it("drops a registration that was waiting on a peer's lock when shutdown removed the entry", async () => {
		peerHolds();
		// session_start's `void registerInstance(cwd)`: it starts, then waits.
		const registration = registry.registerInstance(ROOT_A);
		await waitFor(
			() => degradationCount("instance-registry-lock-legacy-held"),
			(count) => count >= 1,
		);
		peerReleases();
		registry.deregisterInstance(); // the lock is free: the removal runs now
		await registration;

		expect(ownEntry()).toBeUndefined();
		// The sync removal took the lock, so nothing was queued behind it.
		expect(degradationCount("instance-registry-deregister-queued")).toBe(0);
		expect(
			ledger
				.getDegradationSummary()
				.find(
					(group) => group.kind === "instance-registry-registration-superseded",
				)?.latestReasons[0]?.subject,
		).toBe(normalizeFilePath(ROOT_A));
		await expectSessionTwoRegistersAlone();
	});

	it("does not re-create the ended session's entry from an LSP child recorded before shutdown", async () => {
		// An LSP spawn in the turn a session switch interrupts: its
		// fire-and-forget record is still queued when session 1 ends, and it
		// carries session 1's root as a service cwd (clients/lsp/client.ts).
		const recorded = registry.recordLspChild({
			pid: process.pid + 1,
			serverId: "fake-ts",
			command: "fake-tsserver",
			sessionIdentity: {
				projectRoot: ROOT_A,
				rootSource: "service-cwd",
				startedAt: new Date().toISOString(),
			},
		});
		registry.deregisterInstance();
		await recorded;

		expect(ownEntry()).toBeUndefined();
		await expectSessionTwoRegistersAlone();
	});

	it("does not point the heartbeat's repair at the ended root when a secondary's removal lands after shutdown", async () => {
		await registry.registerInstance(ROOT_A);
		await registry.registerInstanceRoot(ROOT_SECONDARY);
		// A peer holds the lock. A declined secondary's shutdown is queued, then
		// session 1 ends: its sync removal cannot take the lock and queues
		// behind the secondary's removal.
		peerHolds();
		const secondaryRemoval = registry.deregisterInstanceRoot(ROOT_SECONDARY);
		registry.deregisterInstance();
		peerReleases();
		await secondaryRemoval;
		await registry._settleRegistryMutationsForTests();
		expect(ownEntry()).toBeUndefined();

		// Session 2's heartbeat, before its own registration lands.
		await registry.updateHeartbeat();
		await registry._settleRegistryMutationsForTests();
		expect(ownEntry()).toBeUndefined();
		await expectSessionTwoRegistersAlone();
	});

	it("keeps another incarnation's entry on this pid when the queued removal lands", async () => {
		await registry.registerInstance(ROOT_A);
		// An entry a crashed earlier instance left on this pid (#3538): the
		// same pid, another start time. It is not this process's to remove.
		const file = JSON.parse(fs.readFileSync(registryFilePath(), "utf8")) as {
			instances: Array<Record<string, unknown>>;
		};
		file.instances.push({
			...file.instances[0],
			processStart: "another-incarnation",
			projectRoot: "/repo/crashed",
			projectRoots: ["/repo/crashed"],
		});
		fs.writeFileSync(registryFilePath(), JSON.stringify(file));

		await shutdownDuringHeartbeat();

		const left = (
			JSON.parse(fs.readFileSync(registryFilePath(), "utf8")) as {
				instances: Array<{ pid: number; processStart?: string }>;
			}
		).instances.filter((entry) => entry.pid === process.pid);
		expect(left.map((entry) => entry.processStart)).toEqual([
			"another-incarnation",
		]);
	});

	it("never points the heartbeat's repair at an ended session's root, and repairs the live one", async () => {
		// Session 1's registration is still queued when session 1 ends, so it
		// starts after the shutdown.
		const registration = registry.registerInstance(ROOT_A);
		registry.deregisterInstance();
		await registration;
		// Session 2's heartbeat runs before its own registration: nothing of
		// session 1 may come back.
		await registry.updateHeartbeat();
		await registry._settleRegistryMutationsForTests();
		expect(ownEntry()).toBeUndefined();

		// Session 2's registration is dropped by a peer's hold (#3447)...
		peerHolds();
		await registry.registerInstance(ROOT_B);
		peerReleases();
		expect(ownEntry()).toBeUndefined();
		// ...and its heartbeat repairs the live root.
		await registry.updateHeartbeat();
		await registry._settleRegistryMutationsForTests();
		expect(ownEntry()).toMatchObject({
			projectRoot: normalizeFilePath(ROOT_B),
			projectRoots: [normalizeFilePath(ROOT_B)],
		});
	});

	it("removes the entry after a peer holds the lock past the sync wait and one async wait", async () => {
		await registry.registerInstance(ROOT_A);
		// A live peer whose lock file ages out of the 5 s lease about 2 s from
		// now: longer than the 500 ms sync wait plus one 500 ms async wait.
		peerHolds(3_000);
		registry.deregisterInstance();
		await registry._settleRegistryMutationsForTests();

		expect(ownEntry()).toBeUndefined();
		await expectSessionTwoRegistersAlone();
	}, 15_000);
});
