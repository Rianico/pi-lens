import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
	capMutationFiles,
	compiledJsPath,
	DEFAULT_MAX_FILES,
	DEFAULT_MAX_RANGES,
	describeStrykerFailure,
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
} from "./lib/stryker-diff.mjs";
import {
	buildLineIndex,
	countLines,
	decodeSourceMapRows,
	mapGeneratedLineToOriginal,
	mapRangesToGenerated,
} from "./lib/mutation-source-map.mjs";

// The PR-body corpus is deliberately real and its cold scan is slower under
// Stryker instrumentation than in the ordinary suite. Keep this budget local
// to the mutation command so the normal test contract remains unchanged.
const MUTATION_TEST_TIMEOUT_MS = 30_000;

// Emits `.js.map` next to each compiled `.js` (tsconfig.build.json does not),
// scoped to the directories this lane mutates through compiled output so it
// never dirties scripts/download-grammars.js, the repo's one checked-in
// build exception (see tsconfig.mutation.json).
const MUTATION_TSCONFIG = "tsconfig.mutation.json";
const REPORT_PATH = "reports/mutation/mutation.json";

function argumentValue(name, fallback) {
	let value = fallback;
	for (let index = 0; index < process.argv.length - 1; index += 1) {
		if (process.argv[index] === name) value = process.argv[index + 1];
	}
	return value;
}

const base = argumentValue("--base", "origin/master");
const maxFiles = Number(argumentValue("--max-files", DEFAULT_MAX_FILES));
const maxRanges = Number(argumentValue("--max-ranges", DEFAULT_MAX_RANGES));
const budgetMinutes = Number(
	argumentValue("--budget-minutes", MUTATION_BUDGET_MINUTES),
);
const budgetMs = Math.round(budgetMinutes * 60_000);

function changedMutationFiles() {
	try {
		return execFileSync(
			"git",
			["diff", "--name-only", "--diff-filter=AM", `${base}...HEAD`],
			{ encoding: "utf8" },
		)
			.split("\n")
			.map((file) => file.trim())
			.filter(Boolean)
			.filter(isMutationSourceFile);
	} catch (error) {
		console.error(
			`mutation diff: could not read ${base}...HEAD: ${error.message}`,
		);
		process.exit(1);
	}
}

function changedLineRanges(files) {
	if (files.length === 0) return new Map();
	try {
		return parseChangedLineRanges(
			execFileSync(
				"git",
				[
					"diff",
					"--unified=0",
					"--diff-filter=AM",
					`${base}...HEAD`,
					"--",
					...files,
				],
				{ encoding: "utf8" },
			),
		);
	} catch (error) {
		console.error(
			`mutation diff: could not read changed lines of ${base}...HEAD: ${error.message}`,
		);
		process.exit(1);
	}
}

function headSha() {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();
	} catch {
		return "unknown-head";
	}
}

function shellQuote(value) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function writeRunConfig(testFiles) {
	mkdirSync(".stryker", { recursive: true });
	const command = [
		"node_modules/.bin/vitest",
		"run",
		"--configLoader",
		"runner",
		"--testTimeout",
		String(MUTATION_TEST_TIMEOUT_MS),
		...testFiles.map(shellQuote),
	].join(" ");
	// buildCommand replaces the scripts-only lane's plain rebuild. Stryker's
	// DisableTypeChecksPreprocessor rewrites every `.ts` in the project in
	// place before the dry run (mtime bump only, restored after the run) --
	// harmless for the scripts lane (tsc never touches .mjs), but a REAL
	// rebuild here would overwrite the compiled `.js` Stryker just
	// instrumented for a compiled mutate target (clients/tools/mcp/index.ts),
	// silently discarding every embedded mutant before a single test runs.
	// mutation-touch-build.mjs only refreshes mtimes -- see its own header.
	const config = `import base from "../stryker.config.mjs";\nexport default { ...base, buildCommand: "node scripts/lib/mutation-touch-build.mjs", commandRunner: { ...base.commandRunner, command: ${JSON.stringify(command)} } };\n`;
	const file = ".stryker/diff.config.mjs";
	writeFileSync(file, config);
	return file;
}

/**
 * Writes the one canonical `reports/mutation/mutation.json` this run
 * produces, whether or not Stryker itself ran. `piLensMutationDiff` is a
 * non-standard top-level key alongside Stryker's own (schemaVersion, files,
 * …); it carries everything `scripts/mutation-report.mjs` and the sticky PR
 * comment need, most importantly `zeroMutants`, which is set on every path
 * that evaluates no mutants so a 0-mutant run can never be rendered as a
 * clean pass.
 */
function writeReport(strykerReport, meta) {
	mkdirSync("reports/mutation", { recursive: true });
	const report = {
		schemaVersion: "mutation-testing-report-schema/1",
		files: {},
		...strykerReport,
		piLensMutationDiff: meta,
	};
	writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
}

function baseMeta(extra) {
	return {
		generatedAt: new Date().toISOString(),
		base,
		headSha: headSha(),
		budgetMinutes,
		maxFiles,
		maxRanges,
		...extra,
	};
}

const allFiles = changedMutationFiles();
const { selected: files, skipped } = capMutationFiles(allFiles, maxFiles);
if (skipped.length > 0) {
	console.log(formatCapNotice(files.length, allFiles.length, skipped));
}
if (files.length === 0) {
	const reason =
		"no PR-changed lines fall under scripts/**/*.mjs, clients/**/*.ts, tools/**/*.ts, mcp/**/*.ts, or index.ts";
	console.log(`mutation diff: no mutants evaluated; ${reason}`);
	writeReport(
		null,
		baseMeta({ zeroMutants: { reason }, filesSkippedOverCap: skipped }),
	);
	process.exit(0);
}

const { covered, uncovered, tests } = mapRelatedTests(files);
for (const file of uncovered) {
	console.log(`mutation diff: no covering test for ${file}`);
}
if (covered.length === 0) {
	const reason =
		"no changed mutation source has a covering test (a relative import from a test file, or a conventional tests/<dir>/<name>.test.ts sibling)";
	console.log(`mutation diff: no mutants evaluated; ${reason}`);
	writeReport(
		null,
		baseMeta({
			zeroMutants: { reason },
			filesSkippedOverCap: skipped,
			filesUncovered: uncovered,
		}),
	);
	process.exit(0);
}

const coveredScripts = covered.filter(isScriptMutationFile);
const coveredCompiled = covered.filter(isCompiledMutationSource);

// Mutate the diff's own lines, not the whole changed file: whole-file
// instrumentation of scripts/check-pr-body.mjs alone is 2075 mutants, and every
// mutant reruns the related tests, so advisory run 36098718085 evaluated none of
// its 2220 before the 90-minute cap cancelled the job.
const scriptPatterns = mutationRangePatterns(
	coveredScripts,
	changedLineRanges(coveredScripts),
);

// jsFile -> { index, totalGeneratedLines, tsFile }, kept for the reverse
// (survivor .js:line -> .ts:line) mapping after the Stryker run.
const compiledIndexByJsFile = new Map();
const compiledPatterns = [];
const compiledSkippedNoMap = [];
const compiledSkippedNoLines = [];

if (coveredCompiled.length > 0) {
	// Build ONCE, with source maps, BEFORE invoking Stryker at all: the
	// compiled `.js` line ranges Stryker mutates are computed from this
	// build's `.js.map`, and Stryker is never asked to rebuild afterwards
	// (see writeRunConfig's buildCommand override) so it can never clobber a
	// mutant it already wrote in place.
	console.log(
		`mutation diff: building ${MUTATION_TSCONFIG} once (with source maps) before instrumentation`,
	);
	const build = spawnSync(
		"node_modules/.bin/tsc",
		["--project", MUTATION_TSCONFIG],
		{ stdio: "inherit" },
	);
	if (build.error || build.status !== 0) {
		console.error(
			"mutation diff: no mutants evaluated; the source-map build for clients/tools/mcp/index.ts failed",
		);
		writeReport(
			null,
			baseMeta({
				zeroMutants: {
					reason: "the source-map build for clients/tools/mcp/index.ts failed",
				},
				filesSkippedOverCap: skipped,
				filesUncovered: uncovered,
			}),
		);
		process.exit(1);
	}

	const compiledRanges = changedLineRanges(coveredCompiled);
	for (const tsFile of coveredCompiled) {
		const jsFile = compiledJsPath(tsFile);
		const mapFile = `${jsFile}.map`;
		if (!existsSync(jsFile) || !existsSync(mapFile)) {
			compiledSkippedNoMap.push(tsFile);
			console.log(
				`mutation diff: no compiled output/source map for ${tsFile}; skipping`,
			);
			continue;
		}
		const rawMap = JSON.parse(readFileSync(mapFile, "utf8"));
		const index = buildLineIndex(decodeSourceMapRows(rawMap));
		const jsContent = readFileSync(jsFile, "utf8");
		const totalGeneratedLines = countLines(jsContent);
		compiledIndexByJsFile.set(jsFile, { index, totalGeneratedLines, tsFile });

		const tsRanges = compiledRanges.get(tsFile) ?? [];
		const jsRanges = mapRangesToGenerated(index, tsRanges, totalGeneratedLines);
		if (jsRanges.length === 0 && tsRanges.length > 0) {
			compiledSkippedNoLines.push(tsFile);
			console.log(
				`mutation diff: ${tsFile} changed lines compile to no code (typings/comments only); skipping`,
			);
		}
		for (const [start, end] of jsRanges) {
			compiledPatterns.push(`${jsFile}:${start}-${end}`);
		}
	}
}

const allPatterns = [...scriptPatterns, ...compiledPatterns];
if (allPatterns.length === 0) {
	const reason =
		"the changed lines compile to no code (typings/comments only) or produced no mutation range";
	console.log(`mutation diff: no mutants evaluated; ${reason}`);
	writeReport(
		null,
		baseMeta({
			zeroMutants: { reason },
			filesSkippedOverCap: skipped,
			filesUncovered: uncovered,
			filesNoSourceMap: compiledSkippedNoMap,
			filesNoMutableLines: compiledSkippedNoLines,
		}),
	);
	process.exit(0);
}

const sha = headSha();
const { selected: patterns, sampled } = sampleRangesDeterministically(
	allPatterns,
	maxRanges,
	sha,
);
if (sampled) {
	console.log(
		`mutation diff: sampled ${patterns.length} of ${allPatterns.length} changed-line ranges deterministically (seed ${sha})`,
	);
}

const configFile = writeRunConfig(tests);
console.log(`mutation diff: mutating ${patterns.join(", ")}`);
console.log(`mutation diff: running related tests ${tests.join(", ")}`);
console.log(`mutation diff: budget ${budgetMinutes} minute(s)`);
const result = spawnSync(
	"node_modules/.bin/stryker",
	["run", "--mutate", patterns.join(","), configFile],
	{
		stdio: "inherit",
		encoding: "utf8",
		timeout: budgetMs,
		killSignal: "SIGTERM",
	},
);

if (result.error || result.status !== 0) {
	const reason = describeStrykerFailure(result, budgetMinutes);
	console.error(reason);
	writeReport(
		null,
		baseMeta({
			zeroMutants: { reason },
			filesSkippedOverCap: skipped,
			filesUncovered: uncovered,
			rangesTotal: allPatterns.length,
			rangesSampled: sampled,
			testsRun: tests,
		}),
	);
	process.exit(1);
}

if (!existsSync(REPORT_PATH)) {
	console.error("mutation diff: report not found after Stryker run");
	writeReport(
		null,
		baseMeta({
			zeroMutants: { reason: "Stryker produced no report file" },
			filesSkippedOverCap: skipped,
		}),
	);
	process.exit(1);
}

try {
	const strykerReport = JSON.parse(readFileSync(REPORT_PATH, "utf8"));
	// The mutation-report schema keys mutants by file; the entries themselves
	// carry no file name (spike 2026-09-09 printed `survived: undefined:59`).
	// Augment each mutant in place with the original (pre-mutation) source
	// snippet, and -- for a compiled clients/tools/mcp/index.ts target --
	// the `.ts` file:line the `.js` survivor maps back to, before writing
	// the report: the file was written once here, and both the sticky PR
	// comment and scripts/mutation-report.mjs render straight off it.
	for (const [fileName, file] of Object.entries(strykerReport.files ?? {})) {
		const compiled = compiledIndexByJsFile.get(fileName);
		let sourceLines = null;
		try {
			sourceLines = readFileSync(fileName, "utf8").split("\n");
		} catch {
			sourceLines = null;
		}
		for (const mutant of file.mutants ?? []) {
			if (sourceLines)
				mutant.original = extractSnippet(sourceLines, mutant.location);
			if (compiled && mutant.location?.start?.line != null) {
				const tsLine = mapGeneratedLineToOriginal(
					compiled.index,
					mutant.location.start.line,
				);
				if (tsLine != null) {
					mutant.tsLocation = { fileName: compiled.tsFile, line: tsLine };
				}
			}
		}
	}

	const mutants = Object.entries(strykerReport.files ?? {}).flatMap(
		([fileName, file]) =>
			(file.mutants ?? []).map((mutant) => ({ ...mutant, fileName })),
	);
	const counts = mutants.reduce((out, mutant) => {
		out[mutant.status] = (out[mutant.status] ?? 0) + 1;
		return out;
	}, {});
	// The mutation-report schema stores no score; Stryker's definition is
	// (killed + timeout) / (total - ignored - no coverage).
	const killed = (counts.Killed ?? 0) + (counts.Timeout ?? 0);
	const denominator =
		mutants.length - (counts.Ignored ?? 0) - (counts.NoCoverage ?? 0);
	const score =
		denominator > 0 ? ((killed / denominator) * 100).toFixed(2) : "n/a";
	console.log(`mutation diff score: ${score}`);
	console.log(`mutation diff counts: ${JSON.stringify(counts)}`);
	for (const mutant of mutants.filter((entry) => entry.status === "Survived")) {
		const location = mutant.tsLocation
			? `${mutant.tsLocation.fileName}:${mutant.tsLocation.line}`
			: `${mutant.fileName}:${mutant.location?.start?.line ?? "?"}`;
		console.log(`survived: ${location} ${mutant.mutatorName}`);
	}

	writeReport(
		strykerReport,
		baseMeta({
			zeroMutants: null,
			filesSkippedOverCap: skipped,
			filesUncovered: uncovered,
			filesNoSourceMap: compiledSkippedNoMap,
			filesNoMutableLines: compiledSkippedNoLines,
			rangesTotal: allPatterns.length,
			rangesEvaluated: patterns.length,
			rangesSampled: sampled,
			testsRun: tests,
			counts,
			score,
		}),
	);
} catch (error) {
	console.error(`mutation diff: report unreadable: ${error.message}`);
	process.exit(1);
}

console.log("mutation diff: completed");
