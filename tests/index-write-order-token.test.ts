/**
 * #3540: the ordering token `index.ts` hands the diagnostics tools orders a
 * later turn after an earlier one.
 *
 * `RuntimeCoordinator.nextWriteIndex()` restarts at every `beginTurn`, while
 * the inline-blocker record a confirmed-clean check retires lives for the
 * session. The tool reserves its token through what `index.ts` injects
 * (`createLensDiagnosticsTool`'s `nextWriteIndex`) and hands it to
 * `retireInlineBlockerOnConfirmedClean` (pinned in
 * `tests/tools/lsp-diagnostics-inline-blocker-retire.test.ts`). A raw write
 * index from turn 2 compared against a turn-1 record's is the bug this file
 * prevents: a file's first check in turn 2 could never retire a verdict its
 * turn-1 dispatch recorded under a higher index.
 *
 * Production chain: the real extension activation (`index.ts`), the real
 * module-level `RuntimeCoordinator` (captured, not replaced) and the real
 * reservation `index.ts` injects (captured from the real tool factory's
 * arguments).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
	runtime: undefined as unknown,
	reserve: undefined as undefined | (() => number),
}));

vi.mock("../clients/runtime-coordinator.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../clients/runtime-coordinator.js")>();
	class CapturedRuntime extends actual.RuntimeCoordinator {
		constructor() {
			super();
			captured.runtime = this;
		}
	}
	return { ...actual, RuntimeCoordinator: CapturedRuntime };
});
vi.mock("../tools/lens-diagnostics.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../tools/lens-diagnostics.js")>();
	return {
		...actual,
		createLensDiagnosticsTool: (
			...args: Parameters<typeof actual.createLensDiagnosticsTool>
		) => {
			captured.reserve = args[4];
			return actual.createLensDiagnosticsTool(...args);
		},
	};
});
vi.mock("../clients/bootstrap.js", async () => {
	const { bootstrapSeamMock } = await import("./support/bootstrap-mock.js");
	return bootstrapSeamMock(async () => ({
		metricsClient: { reset: () => {} },
	}));
});

import type { RuntimeCoordinator } from "../clients/runtime-coordinator.js";
import extension from "../index.js";
import { createPiMock } from "./support/pi-mock.js";
import { removeTempDirSync } from "./clients/test-utils.js";

describe("#3540: index.ts reserves diagnostics-tool tokens turn first", () => {
	let tmp: string;
	let file: string;
	let runtime: RuntimeCoordinator;
	let reserve: () => number;

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-3540-"));
		file = path.join(tmp, "a.ts");
		fs.writeFileSync(file, "export const a = 1;\n");
		const pi = createPiMock({ "no-lsp": true });
		extension(pi.asExtensionAPI());
		runtime = captured.runtime as RuntimeCoordinator;
		reserve = captured.reserve as () => number;
		runtime.resetForSession();
	});

	afterEach(() => {
		removeTempDirSync(tmp);
	});

	/** The file's turn-1 dispatch recorded a blocker under write index 3. */
	function recordTurnOneBlocker(): void {
		runtime.beginTurn();
		for (let write = 0; write < 3; write += 1) runtime.nextWriteIndex();
		runtime.recordInlineBlockers(file, "STOP turn 1", 3, ["lsp"]);
	}

	it("a turn-2 confirmed clean retires a blocker the turn-1 dispatch recorded under a higher write index", () => {
		recordTurnOneBlocker();
		runtime.beginTurn();
		expect(
			runtime.retireInlineBlockerOnConfirmedClean(file, reserve(), ["lsp"]),
		).toBe(true);
		expect(runtime.getInlineBlockersSnapshot()).toEqual([]);
	});

	it("a clean reserved before a newer same-turn dispatch still cannot retire that dispatch's blocker", () => {
		runtime.beginTurn();
		const olderClean = reserve();
		runtime.recordInlineBlockers(file, "STOP newer", runtime.nextWriteIndex(), [
			"lsp",
		]);
		expect(
			runtime.retireInlineBlockerOnConfirmedClean(file, olderClean, ["lsp"]),
		).toBe(false);
		expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
	});

	it("a clean reserved in turn 1 cannot retire a blocker recorded in turn 2", () => {
		runtime.beginTurn();
		const turnOneClean = reserve();
		runtime.beginTurn();
		runtime.recordInlineBlockers(
			file,
			"STOP turn 2",
			runtime.nextWriteIndex(),
			["lsp"],
		);
		expect(
			runtime.retireInlineBlockerOnConfirmedClean(file, turnOneClean, ["lsp"]),
		).toBe(false);
	});
});
