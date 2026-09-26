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

	it("round 4 R3-1: renders 0/no-zeroMutants/no-partial as not a clean pass, backstopping a driver branch that failed to set either", () => {
		// Recurrence: the round-4 review mutated the driver's OWN success/zero
		// branch (`if (mutants.length > 0)` -> `>= 0`) and its partial branch
		// (`if (outcome.partial)` -> `false`) directly, one at a time. BOTH
		// produced a report with the exact same signature reproduced here --
		// zeroMutants unset, partial unset, 0 total counts -- and all four
		// mutation test files stayed green, because nothing but that one
		// driver `if` ever looked at the raw `mutants.length`. This backstop
		// operates on the WRITTEN REPORT alone, so it catches that signature
		// regardless of which driver branch produced it.
		const markdown = renderMutationMarkdown({
			files: {},
			piLensMutationDiff: {
				base: "origin/master",
				headSha: "abc1234567890",
				zeroMutants: null,
				partial: null,
				counts: {},
				score: "n/a",
			},
		});

		expect(markdown).toContain("0 mutants evaluated");
		expect(markdown).toContain("not a clean pass");
		expect(markdown).not.toContain("Score: n/a%");
		expect(markdown).not.toContain("No survivors.");
	});

	it("round 4 R3-1: mutation 2's exact shape (no counts/score field at all, from the interrupted-else path)", () => {
		// The interrupted branch's `else` (taken when `outcome.partial` is
		// falsy) writes `baseMeta({ zeroMutants: outcome.zeroMutants, ... })`
		// with NO `counts`/`score` fields at all -- distinct from the
		// completed-run zero path above, which DOES set them (to `{}`/"n/a").
		// Both must trip the same backstop.
		const markdown = renderMutationMarkdown({
			files: {},
			piLensMutationDiff: {
				base: "origin/master",
				headSha: "abc1234567890",
				zeroMutants: null,
			},
		});

		expect(markdown).toContain("0 mutants evaluated");
		expect(markdown).toContain("not a clean pass");
	});

	it("round 4 R3-1: the backstop does not fire on a genuine partial run with a real (nonzero) evaluated count", () => {
		// The backstop's condition is `!meta.partial && total === 0` -- a
		// partial run with `partial` SET must still render as partial, not
		// fall into the zero-mutant backstop text, even though its own
		// `counts` can legitimately total more than zero mutants evaluated.
		const markdown = renderMutationMarkdown({
			files: {},
			piLensMutationDiff: {
				base: "origin/master",
				headSha: "abc1234",
				zeroMutants: null,
				partial: { reason: "budget expired", evaluated: 3, total: 9 },
				counts: { Killed: 3 },
				score: "100.00",
			},
		});

		expect(markdown).toContain("Partial run");
		expect(markdown).not.toContain("0 mutants evaluated");
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

	it("round 3 R2-1: prints the sampling note on the zero-mutant path too, and the sample-aware reason", () => {
		// Recurrence: a real #3579 replay sampled 1 of 99 ranges (a
		// shorthand-property line with 0 mutants) while the measurement found
		// 710 mutants across all 99 -- the zero-mutant branch returned before
		// ever reaching the "Sampled N of M" note built below it, so the
		// comment read as an unqualified "no mutable code in 99 ranges", with
		// no hint that 98 of those 99 were never even tried.
		const markdown = renderMutationMarkdown({
			files: {},
			piLensMutationDiff: {
				base: "origin/master",
				headSha: "9ebbb5dac2d3157d4a5560366098a85ee5099fd6",
				zeroMutants: {
					reason:
						"0 mutants in 1 sampled of 99 ranges (99 ranges held 710 mutant(s))",
				},
				rangesSampled: true,
				rangesEvaluated: 1,
				rangesTotal: 99,
			},
		});

		expect(markdown).toContain("0 mutants evaluated");
		expect(markdown).toContain(
			"0 mutants in 1 sampled of 99 ranges (99 ranges held 710 mutant(s))",
		);
		expect(markdown).toContain("Sampled 1 of 99");
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
					// round 3 R2-4: describePartialInterruptCause's shape -- never
					// "no mutants evaluated" under a "6 of 9 evaluated" banner.
					reason:
						"mutation diff: the 0.55-minute mutation budget expired before Stryker produced a result",
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
		// Recurrence (round 3 R2-4): the reason sits right under "6 of 9
		// evaluated" -- it must never itself say the run evaluated nothing.
		expect(markdown).not.toContain("no mutants evaluated");
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

describe("renderStaleMarkdown (#3531 round 2 T6, round 3/4 R2-4 wording)", () => {
	it("names the head that produced no report, and carries the sticky marker so a later run finds and updates it", () => {
		const markdown = renderStaleMarkdown({
			headSha: "deadbeef00001234",
			runUrl: undefined,
		});

		expect(markdown).toContain(STICKY_MARKER);
		expect(markdown).toContain("Stale");
		expect(markdown).toContain("deadbeef0000");
		expect(markdown).toContain("no longer reflects this PR's current head");
		// Recurrence (round 3 R2-4): the PATCH this very call produces
		// OVERWRITES the comment with this notice -- "left over" implied no
		// action was taken, when the update is happening right now.
		expect(markdown).not.toContain("left over");
		// Recurrence (round 4, cosmetic): the neutral cause clause used to
		// read "produced no mutation report -- it did not produce one (…)",
		// a doubled sentence.
		expect(markdown).not.toContain("it did not produce one");
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

	it("names BOTH possible causes of a 'cancelled' upstream result -- a superseding push or the job's own time limit", () => {
		// Recurrence (round 4): `needs.mutation.result` reads "cancelled" both
		// when the workflow's own per-PR concurrency group supersedes a run
		// AND when the job runs past its `timeout-minutes` -- this job cannot
		// tell those two apart, so naming only "superseded" would misattribute
		// a genuine timeout to a push that never happened.
		const markdown = renderStaleMarkdown({
			headSha: "abc123",
			upstreamResult: "cancelled",
		});

		expect(markdown).toContain(
			"cancelled: a newer push superseded it, or the job hit its time limit",
		);
		expect(markdown).not.toContain("crash");
	});

	it("words it neutrally (not a specific crash/cancellation claim) when the upstream result is unknown or a genuine failure", () => {
		const markdown = renderStaleMarkdown({
			headSha: "abc123",
			upstreamResult: "failure",
		});

		expect(markdown).not.toContain("superseded");
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
