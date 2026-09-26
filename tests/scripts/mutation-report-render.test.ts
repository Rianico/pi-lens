// flake-shape: real-process-spawn — the subject IS the CLI's own argv
// parsing (--report/--out) and file I/O; an in-process call would test the
// exported render function again, not the entry script's own wiring.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	renderMutationMarkdown,
	renderStaleMarkdown,
	STICKY_MARKER,
} from "../../scripts/lib/mutation-report-render.mjs";

describe("renderMutationMarkdown", () => {
	it("never reads a 0-mutant run as a clean pass, and states the reason", () => {
		// Recurrence (#3531 acceptance): "A run that evaluates 0 mutants MUST
		// say so ... and must never read as a clean pass."
		const markdown = renderMutationMarkdown({
			files: {},
			piLensMutationDiff: {
				base: "origin/master",
				headSha: "abc1234567890",
				zeroMutants: {
					reason: "no PR-changed lines fall under scripts/**/*.mjs, ...",
				},
			},
		});

		expect(markdown).toContain("0 mutants evaluated");
		expect(markdown).toContain("not a clean pass");
		expect(markdown).toContain("no PR-changed lines fall under");
		expect(markdown).not.toMatch(/score/i);
	});

	it("names the --max-files cap and the uncovered files when either applies", () => {
		const markdown = renderMutationMarkdown({
			files: {},
			piLensMutationDiff: {
				base: "origin/master",
				headSha: "abc1234567890",
				zeroMutants: {
					reason: "no changed mutation source has a covering test",
				},
				filesSkippedOverCap: ["clients/z.ts"],
				filesUncovered: ["clients/a.ts"],
			},
		});

		expect(markdown).toContain("clients/z.ts");
		expect(markdown).toContain("clients/a.ts");
	});

	it("tables every survivor with its .ts location when a compiled source maps one", () => {
		const markdown = renderMutationMarkdown({
			files: {
				"clients/runtime-tool-result.js": {
					mutants: [
						{
							id: "1",
							mutatorName: "CallExpression",
							replacement: ";",
							original:
								"runtime.appendCascadePromise(result.cascadePromise, writeSession, filePath);",
							status: "Survived",
							location: {
								start: { line: 1915, column: 9 },
								end: { line: 1915, column: 89 },
							},
							tsLocation: {
								fileName: "clients/runtime-tool-result.ts",
								line: 2515,
							},
						},
					],
				},
			},
			piLensMutationDiff: {
				base: "origin/master",
				headSha: "f9582da8b6189f0f4e512912cf82cd05c2da8b68",
				zeroMutants: null,
				counts: { Survived: 1 },
				score: "0.00",
				testsRun: ["tests/clients/runtime-tool-result.test.ts"],
			},
		});

		expect(markdown).toContain("clients/runtime-tool-result.ts:2515");
		expect(markdown).not.toContain("runtime-tool-result.js:1915");
		expect(markdown).toContain("CallExpression");
		expect(markdown).toContain(
			"`runtime.appendCascadePromise(result.cascadePromise, writeSession, filePath);` → `;`",
		);
	});

	it("falls back to the compiled .js location for a survivor with no ts mapping (e.g. a scripts/**/*.mjs source)", () => {
		const markdown = renderMutationMarkdown({
			files: {
				"scripts/lib/stryker-diff.mjs": {
					mutants: [
						{
							id: "1",
							mutatorName: "StringLiteral",
							replacement: '""',
							status: "Survived",
							location: {
								start: { line: 57, column: 24 },
								end: { line: 57, column: 62 },
							},
						},
					],
				},
			},
			piLensMutationDiff: {
				base: "origin/master",
				headSha: "abc1234",
				zeroMutants: null,
				counts: { Survived: 1 },
				score: "0.00",
			},
		});

		expect(markdown).toContain("scripts/lib/stryker-diff.mjs:57");
	});

	it("says 'no survivors' plainly when every mutant was killed", () => {
		const markdown = renderMutationMarkdown({
			files: {},
			piLensMutationDiff: {
				base: "origin/master",
				headSha: "abc1234",
				zeroMutants: null,
				counts: { Killed: 4 },
				score: "100.00",
			},
		});

		expect(markdown).toContain("No survivors.");
		expect(markdown).not.toContain("| Location |");
	});

	it("names a deterministic sample when the range budget capped the run", () => {
		const markdown = renderMutationMarkdown({
			files: {},
			piLensMutationDiff: {
				base: "origin/master",
				headSha: "deadbeef0000",
				zeroMutants: null,
				counts: { Killed: 40 },
				score: "100.00",
				rangesSampled: true,
				rangesEvaluated: 40,
				rangesTotal: 212,
			},
		});

		expect(markdown).toContain("Sampled 40 of 212");
		expect(markdown).toContain("deadbeef0000".slice(0, 12));
	});

	it("carries the sticky-comment marker so the workflow can find and update its own comment", () => {
		expect(
			renderMutationMarkdown({ files: {}, piLensMutationDiff: {} }),
		).toContain(STICKY_MARKER);
	});

	it("round 2 S2: labels a partial (budget-killed) run distinctly, alongside whatever DID run", () => {
		const markdown = renderMutationMarkdown({
			files: {
				"clients/string-utils.js": {
					mutants: [
						{
							id: "0",
							mutatorName: "ConditionalExpression",
							replacement: "true",
							status: "Killed",
							location: {
								start: { line: 19, column: 12 },
								end: { line: 19, column: 17 },
							},
						},
					],
				},
			},
			piLensMutationDiff: {
				base: "origin/master",
				headSha: "abc1234",
				zeroMutants: null,
				partial: {
					reason:
						"mutation diff: no mutants evaluated; the 0.55-minute mutation budget expired before Stryker produced a result",
					evaluated: 6,
					total: 9,
				},
				counts: { Killed: 6 },
				score: "100.00",
			},
		});

		expect(markdown).toContain("Partial run");
		expect(markdown).toContain("6 of 9 mutant(s) evaluated");
		expect(markdown).toContain("budget expired");
		// The partial run's own real counts still render, same as a complete run.
		expect(markdown).toContain("100.00");
	});

	it("names an unknown total when the partial run's total mutant count could not be measured", () => {
		const markdown = renderMutationMarkdown({
			files: {},
			piLensMutationDiff: {
				zeroMutants: null,
				partial: { reason: "budget expired", evaluated: 3, total: null },
				counts: { Killed: 3 },
				score: "100.00",
			},
		});

		expect(markdown).toContain("3 of an unknown total of mutant(s)");
	});
});

describe("renderStaleMarkdown (#3531 round 2 T6)", () => {
	it("names the head that produced no report, and carries the sticky marker so a later run finds and updates it", () => {
		const markdown = renderStaleMarkdown({
			headSha: "deadbeef00001234",
			runUrl: undefined,
		});

		expect(markdown).toContain(STICKY_MARKER);
		expect(markdown).toContain("Stale");
		expect(markdown).toContain("deadbeef0000");
		expect(markdown).toContain("no longer reflects this PR's current head");
	});

	it("links the job run when a run URL is given", () => {
		const markdown = renderStaleMarkdown({
			headSha: "abc123",
			runUrl: "https://github.com/apmantza/pi-lens/actions/runs/123",
		});

		expect(markdown).toContain(
			"[Job run](https://github.com/apmantza/pi-lens/actions/runs/123)",
		);
	});

	it("renders without throwing when given no context at all", () => {
		expect(() => renderStaleMarkdown()).not.toThrow();
		expect(renderStaleMarkdown()).toContain(STICKY_MARKER);
	});
});

describe("scripts/mutation-report.mjs (CLI)", () => {
	let dir: string;

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("renders a report file to stdout", () => {
		dir = mkdtempSync(join(tmpdir(), "pi-lens-mutation-report-cli-"));
		const reportPath = join(dir, "mutation.json");
		writeFileSync(
			reportPath,
			JSON.stringify({
				files: {},
				piLensMutationDiff: {
					base: "origin/master",
					headSha: "abc1234",
					zeroMutants: { reason: "no mutable diff" },
				},
			}),
		);

		const output = execFileSync(
			"node",
			["scripts/mutation-report.mjs", "--report", reportPath],
			{ encoding: "utf8" },
		);

		expect(output).toContain("0 mutants evaluated");
		expect(output).toContain("no mutable diff");
	});

	it("exits non-zero with a clear message when the report file is missing", () => {
		expect(() =>
			execFileSync(
				"node",
				[
					"scripts/mutation-report.mjs",
					"--report",
					"/nonexistent/mutation.json",
				],
				{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
			),
		).toThrow();
	});
});
