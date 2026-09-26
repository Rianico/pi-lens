/**
 * #3576: `agent_settled`'s post-drain observed-ledger refresh belongs to the
 * session its drain started in.
 *
 * `refreshObservedLedgerSafely` runs after the deferred drain and re-baselines
 * the files the drain handed the observed-mutation net, with the read guard of
 * whichever session is current. `/new`, fork or resume can run while the drain
 * awaits its formatter; a refresh after that walks the next session's
 * `handled` set with the next session's read guard. This file prevents that
 * recurrence: the refresh of a drain whose session was replaced is dropped
 * with one generation-guard ledger row, and a drain that stays in its session
 * still refreshes (shape 54).
 *
 * Production chain: the real extension activation and `agent_settled`
 * handler (`index.ts`), the real module-level `RuntimeCoordinator` handed to
 * the drain, and the real `refreshObservedMutationLedger` (wrapped, not
 * replaced). The drain itself is doubled: it only replaces the session, the
 * way `/new` lands while the real drain awaits its formatter.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const drain = vi.hoisted(() => ({ replaceSession: false }));
const refresh = vi.hoisted(() => ({ calls: 0 }));

vi.mock("../clients/bootstrap.js", async () => {
	const { bootstrapSeamMock } = await import("./support/bootstrap-mock.js");
	return bootstrapSeamMock(async () => ({
		metricsClient: { reset: () => {} },
	}));
});
vi.mock("../clients/runtime-session.js", () => ({
	handleSessionStart: async (deps: {
		runtime: { projectRoot: string };
		ctxCwd?: string;
	}) => {
		if (deps.ctxCwd) deps.runtime.projectRoot = deps.ctxCwd;
	},
}));
vi.mock("../clients/runtime-agent-end.js", () => ({
	handleAgentEnd: vi.fn(
		async (deps: { runtime: { resetForSession: () => void } }) => {
			if (drain.replaceSession) deps.runtime.resetForSession();
			return undefined;
		},
	),
}));
vi.mock("../clients/observed-mutation.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../clients/observed-mutation.js")>();
	return {
		...actual,
		refreshObservedMutationLedger: (
			...args: Parameters<typeof actual.refreshObservedMutationLedger>
		) => {
			refresh.calls += 1;
			return actual.refreshObservedMutationLedger(...args);
		},
	};
});

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../clients/degradation-ledger.js";
import extension from "../index.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";
import { removeTempDirSync } from "./clients/test-utils.js";

describe("#3576: the post-drain ledger refresh stays in the drain's session", () => {
	let tmp: string;
	let prevDataDir: string | undefined;

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-3576-refresh-"));
		prevDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(tmp, "data");
		refresh.calls = 0;
		resetDegradationLedger();
	});

	afterEach(() => {
		if (prevDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = prevDataDir;
		removeTempDirSync(tmp);
	});

	async function settle(replaceSession: boolean): Promise<void> {
		drain.replaceSession = replaceSession;
		const pi = createPiMock({ "no-lsp": true });
		extension(pi.asExtensionAPI());
		const ctx = makeCtx({ cwd: tmp, sessionId: "s-3576-refresh" });
		await pi.emit("session_start", { reason: "startup" }, ctx);
		await pi.emit("agent_settled", {}, ctx);
	}

	it("a drain whose session was replaced does not refresh the next session's ledger", async () => {
		await settle(true);
		expect(refresh.calls).toBe(0);
		expect(
			getDegradationSummary()
				.filter((group) => group.kind === "generation-guard-stale-write")
				.flatMap((group) => group.latestReasons.map((r) => r.subject)),
		).toEqual([`runtime-session:observed-ledger-refresh:${tmp}`]);
	});

	it("no-drop (shape 54): a drain that stays in its session refreshes the ledger", async () => {
		await settle(false);
		expect(refresh.calls).toBe(1);
	});
});
