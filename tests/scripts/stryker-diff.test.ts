import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	capMutationFiles,
	compiledJsPath,
	describeStrykerFailure,
	DEFAULT_MAX_RANGES,
	extractSnippet,
	formatCapNotice,
	isCompiledMutationSource,
	isMutationSourceFile,
	isScriptMutationFile,
	mapRelatedTests,
	MUTATION_BUDGET_MINUTES,
	mutationRangePatterns,
	parseChangedLineRanges,
	sampleRangesDeterministically,
} from "../../scripts/lib/stryker-diff.mjs";

const config = readFileSync(
	resolve(import.meta.dirname, "../../stryker.config.mjs"),
	"utf8",
);
const driver = readFileSync(
	resolve(import.meta.dirname, "../../scripts/stryker-diff.mjs"),
	"utf8",
);
const workflow = readFileSync(
	resolve(import.meta.dirname, "../../.github/workflows/mutation.yml"),
	"utf8",
);

describe("stryker diff selection", () => {
	it.each([
		["extensionless", 'import "../../scripts/lib/ci-checks"'],
		["javascript extension", 'import "../../scripts/lib/ci-checks.js"'],
		["module extension", 'import "../../scripts/lib/ci-checks.mjs"'],
		["side-effect", 'import "../../scripts/lib/ci-checks"'],
		["dynamic", 'await import("../../scripts/lib/ci-checks")'],
	])("maps %s relative imports to the changed script", (_form, source) => {
		// Recurrence: extension spelling and import form must not hide a related
		// test from the incremental mutation lane.
		const result = mapRelatedTests(["scripts/lib/ci-checks.mjs"], {
			testFiles: ["tests/scripts/related.test.ts"],
			readFile: () => source,
		});

		expect(result.related.get("scripts/lib/ci-checks.mjs")).toEqual(
			new Set(["tests/scripts/related.test.ts"]),
		);
	});

	it("maps changed scripts to imported and conventional sibling tests", () => {
		// Recurrence: the mutation lane must run tests that import the changed
		// script, including scripts without a same-path test mirror.
		const result = mapRelatedTests(
			["scripts/lib/ci-checks.mjs", "scripts/guard-bash.mjs"],
			{
				testFiles: [
					"tests/scripts/ci-verdict.test.ts",
					"tests/scripts/guard-bash.test.ts",
				],
				readFile: (file) =>
					file.includes("ci-verdict")
						? 'import checks from "../../scripts/lib/ci-checks.mjs"'
						: "",
			},
		);

		expect(result.related.get("scripts/lib/ci-checks.mjs")).toEqual(
			new Set(["tests/scripts/ci-verdict.test.ts"]),
		);
		expect(result.related.get("scripts/guard-bash.mjs")).toEqual(
			new Set(["tests/scripts/guard-bash.test.ts"]),
		);
		expect(result.tests).toEqual([
			"tests/scripts/ci-verdict.test.ts",
			"tests/scripts/guard-bash.test.ts",
		]);
	});

	it("reports changed scripts with no covering test instead of silently selecting none", () => {
		// Recurrence: a changed mutation target without a related test must be a
		// review finding, not an accidental green mutation run.
		const result = mapRelatedTests(["scripts/uncovered.mjs"], {
			testFiles: ["tests/scripts/other.test.ts"],
			readFile: () => "",
		});

		expect(result.uncovered).toEqual(["scripts/uncovered.mjs"]);
		expect(result.covered).toEqual([]);
		expect(result.tests).toEqual([]);
	});

	it("caps the mutation population alphabetically and names skipped files", () => {
		// Recurrence: an unbounded changed-script population can turn the
		// advisory lane into an unbounded CI cost.
		const result = capMutationFiles(
			["scripts/z.mjs", "scripts/a.mjs", "scripts/m.mjs"],
			2,
		);

		expect(result.selected).toEqual(["scripts/a.mjs", "scripts/m.mjs"]);
		expect(result.skipped).toEqual(["scripts/z.mjs"]);
		expect(formatCapNotice(2, 3, result.skipped)).toBe(
			"capped: 2 of 3 changed files mutated; skipped: scripts/z.mjs",
		);
	});

	it("keeps the mutation population on scripts mjs files", () => {
		// Recurrence: mutating compiled clients or test sources produces vacuous
		// mutants because this lane activates the built runtime in memory.
		expect(isScriptMutationFile("scripts/hooks/guard-bash.mjs")).toBe(true);
		expect(isScriptMutationFile("scripts/example.test.mjs")).toBe(false);
		expect(isScriptMutationFile("clients/runtime.ts")).toBe(false);
		expect(config).toContain('testRunner: "command"');
		expect(config).toContain(
			'command: "node_modules/.bin/vitest run --configLoader runner"',
		);
		expect(config).toContain('"scripts/**/*.mjs", "!scripts/**/*.test.mjs"');
		expect(config).toContain('coverageAnalysis: "off"');
		expect(config).not.toContain("vitest:");
		// Spike 2026-09-09: TypeScript 7 lacks the API Stryker's sandbox tsconfig
		// preprocessor calls, so the lane mutates in place; the in-place reset
		// drops compiled clients/*.js, so one build runs before the dry run.
		// Neither implies a per-mutant rebuild: the population is .mjs run directly.
		expect(config).toContain('buildCommand: "npm run build"');
		expect(config).toContain("inPlace: true");
		expect(config).not.toContain("clients/");
		expect(driver).toContain('"--testTimeout"');
		expect(driver).toContain("MUTATION_TEST_TIMEOUT_MS = 30_000");
	});
});

describe("stryker diff mutation ranges", () => {
	it("reads the new-side line range of every hunk, per file", () => {
		// Recurrence: run 36098718085 instrumented 2220 whole-file mutants and
		// evaluated none inside the 90-minute cap. The lane must mutate the diff's
		// own lines, and it must read the "+" side of the hunk header: the "-"
		// side numbers lines in the base, so mutants would land on unrelated
		// HEAD lines.
		const diff = [
			"diff --git a/scripts/one.mjs b/scripts/one.mjs",
			"--- a/scripts/one.mjs",
			"+++ b/scripts/one.mjs",
			"@@ -394 +394 @@ const cache = new Map();",
			"-old",
			"+new",
			"@@ -761 +761,5 @@ function extract(value) {",
			"-old",
			"+a",
			"+b",
			"+c",
			"+d",
			"+e",
			"diff --git a/scripts/two.mjs b/scripts/two.mjs",
			"--- a/scripts/two.mjs",
			"+++ b/scripts/two.mjs",
			"@@ -10,0 +11,5 @@ import {",
			"+one",
			"",
		].join("\n");

		expect(parseChangedLineRanges(diff)).toEqual(
			new Map([
				[
					"scripts/one.mjs",
					[
						[394, 394],
						[761, 765],
					],
				],
				["scripts/two.mjs", [[11, 15]]],
			]),
		);
	});

	it("keeps a deletion-only hunk inside a one-line range Stryker accepts", () => {
		// Recurrence: "+c,0" (and "+0,0" at the top of a file) would compute an
		// end line below the start line, and Stryker rejects an inverted mutation
		// range during options validation — zero mutants, before the dry run.
		const diff = [
			"+++ b/scripts/one.mjs",
			"@@ -40,3 +39,0 @@ function gone() {",
			"-a",
			"@@ -1,2 +0,0 @@",
			"-header",
			"",
		].join("\n");

		expect(parseChangedLineRanges(diff)).toEqual(
			new Map([
				[
					"scripts/one.mjs",
					[
						[39, 39],
						[1, 1],
					],
				],
			]),
		);
	});

	it("builds one Stryker mutate pattern per range and skips files with none", () => {
		// Recurrence: a bare path in --mutate is read by Stryker as "mutate the
		// whole file", which is exactly the 2220-mutant population that made the
		// lane evaluate nothing.
		const ranges = new Map<string, Array<[number, number]>>([
			[
				"scripts/one.mjs",
				[
					[394, 394],
					[761, 765],
				],
			],
			["scripts/other.mjs", [[3, 4]]],
		]);

		expect(
			mutationRangePatterns(
				["scripts/one.mjs", "scripts/mode-only.mjs"],
				ranges,
			),
		).toEqual(["scripts/one.mjs:394-394", "scripts/one.mjs:761-765"]);
	});
});

describe("stryker diff wall-clock budget", () => {
	it("bounds the driver strictly below the advisory job cap", () => {
		// Recurrence: run 36098718085 was cancelled by the runner at
		// timeout-minutes, so the driver never regained control and its
		// "no mutants evaluated" message never printed. The driver's own bound
		// must leave the job room to report it.
		const cap = Number(/timeout-minutes:\s*(\d+)/.exec(workflow)?.[1]);

		expect(cap).toBeGreaterThan(0);
		expect(MUTATION_BUDGET_MINUTES).toBeLessThan(cap);
		expect(cap - MUTATION_BUDGET_MINUTES).toBeGreaterThanOrEqual(20);
	});

	it("names the budget as the cause when Stryker is killed at the bound", () => {
		// Recurrence: "the budget ran out" must not be reported with the same
		// wording as "the dry run failed", or issue #2991's distinction between
		// "I tested nothing" and "I tested and found nothing" is lost again.
		// Measured: spawnSync reports an expired timeout as error.code
		// ETIMEDOUT, and signal is null when the child exits on the signal
		// itself -- Stryker's UnexpectedExitHandler does exactly that.
		const expired = describeStrykerFailure(
			{
				status: 143,
				signal: null,
				error: Object.assign(new Error("spawnSync ETIMEDOUT"), {
					code: "ETIMEDOUT",
				}),
			},
			60,
		);

		expect(expired).toContain("no mutants evaluated");
		expect(expired).toContain("60-minute mutation budget expired");

		const failed = describeStrykerFailure(
			{ status: 1, signal: null, error: undefined },
			60,
		);

		expect(failed).toContain("no mutants evaluated");
		expect(failed).toContain("Stryker status 1");
		expect(failed).not.toContain("budget expired");
	});

	it("wires the budget into the Stryker child and the mutate patterns", () => {
		// Recurrence: a formatted budget message with no bound on the child is
		// inert -- the runner still cancels the job. The executable proof is the
		// quoted budget-expiry transcript in the PR body; this pins the wiring in
		// the driver, which is a top-level script and cannot be imported.
		expect(driver).toContain("timeout: budgetMs");
		expect(driver).toContain("--budget-minutes");
		expect(driver).toContain("mutationRangePatterns");
		expect(driver).toContain("describeStrykerFailure");
	});

	it("never lets a post-instrument buildCommand run (the #3531 clobber the fix guards against)", () => {
		// Recurrence: Stryker writes the instrumented (mutation-switch-embedded)
		// `.js` to disk during sandbox init, BEFORE buildCommand runs -- a real
		// rebuild there would silently overwrite it before a single mutant test
		// executes (verified against Stryker's own Sandbox/MutantInstrumenter
		// source, 2026-09-26). The driver must never restore "npm run build" as
		// buildCommand for this lane.
		expect(driver).toContain("mutation-touch-build.mjs");
		expect(driver).not.toContain('buildCommand: "npm run build"');
	});
});

describe("compiled-source mutation targets (#3531 rescope)", () => {
	it("classifies clients/tools/mcp .ts sources and the root index.ts, excluding tests and .d.ts", () => {
		expect(isCompiledMutationSource("clients/atomic-write.ts")).toBe(true);
		expect(isCompiledMutationSource("clients/lsp/inferred-project.ts")).toBe(
			true,
		);
		expect(isCompiledMutationSource("tools/lens-diagnostics.ts")).toBe(true);
		expect(isCompiledMutationSource("mcp/server.ts")).toBe(true);
		expect(isCompiledMutationSource("index.ts")).toBe(true);

		expect(isCompiledMutationSource("clients/atomic-write.test.ts")).toBe(
			false,
		);
		expect(isCompiledMutationSource("clients/some-types.d.ts")).toBe(false);
		expect(isCompiledMutationSource("scripts/lib/ci-checks.mjs")).toBe(false);
		expect(isCompiledMutationSource("tests/clients/atomic-write.test.ts")).toBe(
			false,
		);
		// Recurrence: mutating the .ts source directly (rather than the
		// compiled .js the tests execute) produces vacuous mutants -- the
		// scripts-only classifier must stay false for every compiled class.
		expect(isScriptMutationFile("clients/atomic-write.ts")).toBe(false);
	});

	it("computes the compiled sibling with no outDir remap", () => {
		// Recurrence: tsconfig.build.json has no outDir, so tsc writes .js next
		// to .ts (verified against a real build, 2026-09-26) -- a compiledJsPath
		// that assumed a dist/ prefix would point at a file that never exists.
		expect(compiledJsPath("clients/atomic-write.ts")).toBe(
			"clients/atomic-write.js",
		);
		expect(compiledJsPath("clients/lsp/inferred-project.ts")).toBe(
			"clients/lsp/inferred-project.js",
		);
		expect(compiledJsPath("index.ts")).toBe("index.js");
	});

	it("is a mutation source file through the union, whether scripted or compiled", () => {
		expect(isMutationSourceFile("scripts/lib/ci-checks.mjs")).toBe(true);
		expect(isMutationSourceFile("clients/atomic-write.ts")).toBe(true);
		expect(isMutationSourceFile("docs/pi-lens-monitor.md")).toBe(false);
	});
});

describe("mapRelatedTests generalized to compiled sources", () => {
	it("matches a compiled source's test import even though tests import the .js specifier", () => {
		// Recurrence: TypeScript's nodenext resolution (and this repo's own
		// tests, e.g. tests/index-wiring.test.ts importing "../index.js")
		// import a compiled source by its .js specifier, never .ts -- the
		// normalizer must strip both extensions to match them.
		const result = mapRelatedTests(["clients/atomic-write.ts"], {
			testFiles: ["tests/clients/gzip-stage-write.test.ts"],
			readFile: () =>
				'import { STAGE_TMP_PATTERN } from "../../clients/atomic-write.js";',
		});

		expect(result.related.get("clients/atomic-write.ts")).toEqual(
			new Set(["tests/clients/gzip-stage-write.test.ts"]),
		);
		expect(result.covered).toEqual(["clients/atomic-write.ts"]);
	});

	it("matches the conventional tests/<dir>/<name>.test.ts sibling for a compiled source", () => {
		const result = mapRelatedTests(["clients/atomic-write.ts"], {
			testFiles: ["tests/clients/atomic-write.test.ts"],
			readFile: () => "",
		});

		expect(result.related.get("clients/atomic-write.ts")).toEqual(
			new Set(["tests/clients/atomic-write.test.ts"]),
		);
	});

	it("reports a covered compiled source alongside an uncovered one in the same call", () => {
		const result = mapRelatedTests(
			["clients/atomic-write.ts", "clients/uncovered-thing.ts"],
			{
				testFiles: ["tests/clients/atomic-write.test.ts"],
				readFile: () => "",
			},
		);

		expect(result.covered).toEqual(["clients/atomic-write.ts"]);
		expect(result.uncovered).toEqual(["clients/uncovered-thing.ts"]);
	});
});

describe("sampleRangesDeterministically (#3531 budget sampling)", () => {
	it("keeps every pattern unchanged, and reports no sampling, under the limit", () => {
		const patterns = ["a.js:1-1", "b.js:2-2"];
		expect(sampleRangesDeterministically(patterns, 5, "sha-1")).toEqual({
			selected: patterns,
			sampled: false,
		});
	});

	it("is deterministic for the same seed: repeated calls select the identical subset", () => {
		const patterns = Array.from({ length: 50 }, (_, i) => `f${i}.js:${i}-${i}`);
		const first = sampleRangesDeterministically(patterns, 10, "head-sha-abc");
		const second = sampleRangesDeterministically(patterns, 10, "head-sha-abc");

		expect(first.sampled).toBe(true);
		expect(first.selected).toHaveLength(10);
		expect(second.selected).toEqual(first.selected);
	});

	it("samples a different subset for a different seed (a different head SHA)", () => {
		// Recurrence: a sample that ignores the seed is either fixed (always
		// the same slice, hiding whichever mutants sort last) or effectively
		// random (Math.random()) -- neither is reproducible per-PR-head. This
		// does not prove every seed differs, only that the seed is load-bearing
		// for at least one representative pair.
		const patterns = Array.from({ length: 50 }, (_, i) => `f${i}.js:${i}-${i}`);
		const a = sampleRangesDeterministically(patterns, 10, "sha-aaaa");
		const b = sampleRangesDeterministically(patterns, 10, "sha-bbbb");

		expect(a.selected).not.toEqual(b.selected);
	});

	it("preserves the input order of the selected patterns", () => {
		const patterns = Array.from({ length: 30 }, (_, i) => `f${i}.js:${i}-${i}`);
		const { selected } = sampleRangesDeterministically(patterns, 10, "seed");
		const indices = selected.map((pattern) => patterns.indexOf(pattern));
		expect(indices).toEqual([...indices].sort((x, y) => x - y));
	});

	it("keeps the run's own default range budget positive and finite", () => {
		expect(DEFAULT_MAX_RANGES).toBeGreaterThan(0);
		expect(Number.isFinite(DEFAULT_MAX_RANGES)).toBe(true);
	});
});

describe("extractSnippet (survivor original-text extraction)", () => {
	const sourceLines = [
		"\tif (!Number.isInteger(maxFiles) || maxFiles < 0) {",
		'\t\tthrow new RangeError("x");',
		"\t}",
	];

	it("slices the exact 1-based column span of a single-line mutant location", () => {
		// Pinned against a real Stryker report (scripts/lib/stryker-diff.mjs:56,
		// columns 6-49), 2026-09-26.
		expect(
			extractSnippet(sourceLines, {
				start: { line: 1, column: 6 },
				end: { line: 1, column: 49 },
			}),
		).toBe("!Number.isInteger(maxFiles) || maxFiles < 0");
	});

	it("truncates a multi-line span to its first line with a marker", () => {
		expect(
			extractSnippet(sourceLines, {
				start: { line: 1, column: 51 },
				end: { line: 3, column: 2 },
			}),
		).toBe("{ … (multi-line)");
	});

	it("returns undefined when the mutant carries no location", () => {
		expect(extractSnippet(sourceLines, undefined)).toBeUndefined();
	});
});
