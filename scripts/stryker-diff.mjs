import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import base from "../stryker.config.mjs";
import {
	augmentAndSummarize,
	buildRunConfig,
	capMutationFiles,
	compiledJsPath,
	decideMutationOutcome,
	dedupePatterns,
	DEFAULT_MAX_FILES,
	DEFAULT_MAX_RANGES,
	describePartialInterruptCause,
	describeStrykerFailure,
	estimateAffordableMutants,
	formatCapNotice,
	isCompiledMutationSource,
	isMutationSourceFile,
	isScriptMutationFile,
	mapRelatedTests,
	MUTATION_BUDGET_MINUTES,
	mutationRangePatterns,
	parseChangedLineRanges,
	parseDryRunCost,
	planResample,
	sampleRangesDeterministically,
} from "./lib/stryker-diff.mjs";
import {
	buildLineIndex,
	countLines,
	createTracer,
	decodeSourceMapRows,
	mapRangesToGenerated,
} from "./lib/mutation-source-map.mjs";

const startedAt = Date.now();

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
const INCREMENTAL_PATH = ".stryker/incremental.json";
// stryker.config.mjs's own concurrency, read from the live import rather than
// duplicated here (single-source-of-truth): round 2 S2's budget arithmetic
// needs it, and a future change to the base config must not silently drift
// the two apart.
const CONCURRENCY = base.concurrency;

function argumentValue(name, fallback) {
	let value = fallback;
	for (let index = 0; index < process.argv.length - 1; index += 1) {
		if (process.argv[index] === name) value = process.argv[index + 1];
	}
	return value;
}

const baseRef = argumentValue("--base", "origin/master");
const maxFiles = Number(argumentValue("--max-files", DEFAULT_MAX_FILES));
const maxRanges = Number(argumentValue("--max-ranges", DEFAULT_MAX_RANGES));
const budgetMinutes = Number(
	argumentValue("--budget-minutes", MUTATION_BUDGET_MINUTES),
);
const budgetMs = Math.round(budgetMinutes * 60_000);
// round 2 T6: the CI merge-ref SHA (`git rev-parse HEAD` under a
// `pull_request` checkout) is neither the PR's own head commit nor stable
// across re-runs once master moves, so it cannot label a comment a reader
// can match to a PR commit, and it breaks the "same head samples the same
// subset" reproducibility claim. `--head-sha` carries
// `github.event.pull_request.head.sha` from the workflow; local runs (no
// PR event) fall back to `git rev-parse HEAD`.
const headShaArg = argumentValue("--head-sha", null);

function changedMutationFiles() {
	try {
		return execFileSync(
			"git",
			["diff", "--name-only", "--diff-filter=AM", `${baseRef}...HEAD`],
			{ encoding: "utf8" },
		)
			.split("\n")
			.map((file) => file.trim())
			.filter(Boolean)
			.filter(isMutationSourceFile);
	} catch (error) {
		console.error(
			`mutation diff: could not read ${baseRef}...HEAD: ${error.message}`,
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
					`${baseRef}...HEAD`,
					"--",
					...files,
				],
				{ encoding: "utf8" },
			),
		);
	} catch (error) {
		console.error(
			`mutation diff: could not read changed lines of ${baseRef}...HEAD: ${error.message}`,
		);
		process.exit(1);
	}
}

function gitHeadSha() {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();
	} catch {
		return "unknown-head";
	}
}

const sha = headShaArg ?? gitHeadSha();

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
	const config = buildRunConfig(base, { command });
	const file = ".stryker/diff.config.mjs";
	// A plain object with no functions (verified: every stryker.config.mjs
	// field is JSON-serializable) -- see buildRunConfig's own header for why
	// this replaced a hand-built template-literal string (round 2 T1).
	writeFileSync(
		file,
		`export default ${JSON.stringify(config, null, "\t")};\n`,
	);
	return file;
}

/**
 * Writes the one canonical `reports/mutation/mutation.json` this run
 * produces, whether or not Stryker itself ran. `piLensMutationDiff` is a
 * non-standard top-level key alongside Stryker's own (schemaVersion, files,
 * …); it carries everything `scripts/mutation-report.mjs` and the sticky PR
 * comment need, most importantly `zeroMutants`, which is set on every path
 * that evaluates no mutants so a 0-mutant run can never be rendered as a
 * clean pass, and `partial`, set when a budget kill produced SOME results
 * (round 2 S2) but not all of them.
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

// F1 (#3592 round 2): declared here, BEFORE `baseMeta`, not down at the dry-run
// measurement site where it used to live. `baseMeta` is called from FOUR
// early-exit paths above this point (no changed mutation source, no covering
// test, a source-map build failure, no mutation range) -- every one of them
// runs before the dry-run measurement, so a `let` declared past `baseMeta`
// left every early exit in the temporal dead zone: `ReferenceError: Cannot
// access 'costEstimate' before initialization`, thrown OUT OF baseMeta itself,
// with no report ever written and the run exiting 1 as a crash rather than 0
// with a `zeroMutants` report (reproduced live at 69413b03e -- see
// "no PR-changed lines" in the spawn test below).
let costEstimate = null;

function baseMeta(extra) {
	return {
		generatedAt: new Date().toISOString(),
		base: baseRef,
		headSha: sha,
		budgetMinutes,
		maxFiles,
		maxRanges,
		partial: null,
		// #3592 item 2: the dry-run measurement's total (set once the
		// `--dryRunOnly` measurement parses successfully -- see `costEstimate`
		// above), carried into EVERY report through this one function so the
		// renderer has something to cross-check a completed run's evaluated
		// count against, independent of whether `partial`/`zeroMutants` were
		// correctly set. null before the measurement runs (the early-exit
		// zero-mutant paths above) or when Stryker's dry-run output could not
		// be parsed (`parseDryRunCost` returned null).
		measuredTotalMutants: costEstimate?.totalMutants ?? null,
		...extra,
	};
}

function logSurvivors(mutants) {
	for (const mutant of mutants.filter((entry) => entry.status === "Survived")) {
		const location = mutant.tsLocation
			? `${mutant.tsLocation.fileName}:${mutant.tsLocation.line}`
			: `${mutant.fileName}:${mutant.location?.start?.line ?? "?"}`;
		console.log(`survived: ${location} ${mutant.mutatorName}`);
	}
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

// round 2 T8: build ONCE, unconditionally, before instrumentation -- even a
// scripts-only diff. A scripts-only local rerun previously skipped this
// build entirely (it ran only `if (coveredCompiled.length > 0)`), so a
// locally stale compiled `.js` from an unrelated earlier edit could defeat
// tests/support/check-build-freshness.ts's guard for the WHOLE run, not
// just the scripts lane's own targets.
console.log(
	`mutation diff: building ${MUTATION_TSCONFIG} once (with source maps) before instrumentation`,
);
const build = spawnSync(
	"node_modules/.bin/tsc",
	["--project", MUTATION_TSCONFIG],
	{ stdio: "inherit" },
);
if (build.error || build.status !== 0) {
	const reason = "the source-map build (tsconfig.mutation.json) failed";
	console.error(`mutation diff: no mutants evaluated; ${reason}`);
	writeReport(
		null,
		baseMeta({
			zeroMutants: { reason },
			filesSkippedOverCap: skipped,
			filesUncovered: uncovered,
		}),
	);
	process.exit(1);
}

// Mutate the diff's own lines, not the whole changed file: whole-file
// instrumentation of scripts/check-pr-body.mjs alone is 2075 mutants, and every
// mutant reruns the related tests, so advisory run 36098718085 evaluated none of
// its 2220 before the 90-minute cap cancelled the job.
const scriptPatterns = mutationRangePatterns(
	coveredScripts,
	changedLineRanges(coveredScripts),
);

// jsFile -> { index, tsFile }, kept for the reverse (survivor .js:line -> .ts:line)
// mapping after the Stryker run; `index.tracer` (round 2 S3) makes that
// mapping column-aware.
const compiledIndexByJsFile = new Map();
const compiledPatterns = [];
const compiledSkippedNoMap = [];
const compiledSkippedNoLines = [];

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
	const rows = decodeSourceMapRows(rawMap);
	const index = { ...buildLineIndex(rows), tracer: createTracer(rawMap) };
	const jsContent = readFileSync(jsFile, "utf8");
	const totalGeneratedLines = countLines(jsContent);
	compiledIndexByJsFile.set(jsFile, { index, tsFile });

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

// round 2 S3: the same collapsed generated range can arise from two
// different .ts hunks (or a scripts and a compiled pattern landing on an
// identical span); a duplicate spends a range-budget slot on a mutant
// Stryker would test identically the first time.
const allPatterns = dedupePatterns([...scriptPatterns, ...compiledPatterns]);
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

function remainingBudgetMs() {
	return Math.max(0, budgetMs - (Date.now() - startedAt));
}

// round 2 S2: measure the REAL dry-run cost (a fixed range count, however
// chosen, bounds nothing -- 40 ranges yielded 290 mutants and a ~3.4h run
// against #3579's real related-test set of 768 tests, measured 2026-09-26)
// before deciding what fits the budget, via Stryker's own `--dryRunOnly`
// (no mutation testing, no report -- console-only "Instrumented N mutant(s)"
// and "Ran … (net … ms)" lines, `parseDryRunCost` reads both).
console.log(
	`mutation diff: measuring dry-run cost for ${allPatterns.length} candidate range(s)`,
);
const measureConfigFile = writeRunConfig(tests);
const measureResult = spawnSync(
	"node_modules/.bin/stryker",
	["run", "--mutate", allPatterns.join(","), "--dryRunOnly", measureConfigFile],
	{
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf8",
		timeout: remainingBudgetMs(),
		killSignal: "SIGTERM",
	},
);
const measureOutput = `${measureResult.stdout ?? ""}${measureResult.stderr ?? ""}`;
console.log(measureOutput);

let patterns = allPatterns;
let sampled = false;

if (measureResult.error || measureResult.status !== 0) {
	// The measurement dry run IS the real run's own dry run (same tests, same
	// code): if it fails here, the real run would fail identically, so report
	// that failure now instead of spending a second, redundant dry run.
	const reason = describeStrykerFailure(measureResult, budgetMinutes);
	console.error(reason);
	writeReport(
		null,
		baseMeta({
			zeroMutants: { reason },
			filesSkippedOverCap: skipped,
			filesUncovered: uncovered,
			rangesTotal: allPatterns.length,
			testsRun: tests,
		}),
	);
	process.exit(1);
}

const cost = parseDryRunCost(measureOutput);
if (!cost) {
	console.log(
		"mutation diff: could not parse Stryker's dry-run cost output; falling back to the default range cap",
	);
	const fallback = sampleRangesDeterministically(allPatterns, maxRanges, sha);
	patterns = fallback.selected;
	sampled = fallback.sampled;
} else {
	costEstimate = cost;
	if (cost.totalMutants === 0) {
		// round 2 R2-2: routed through decideMutationOutcome, the same pure
		// function the post-run and partial branches use below, so this branch
		// is no longer an untested `if` of its own.
		const outcome = decideMutationOutcome({
			interrupted: false,
			mutants: [],
			sampled: false,
			rangesEvaluated: allPatterns.length,
			rangesTotal: allPatterns.length,
			totalMutants: cost.totalMutants,
		});
		console.log(
			`mutation diff: no mutants evaluated; ${outcome.zeroMutants.reason}`,
		);
		writeReport(
			null,
			baseMeta({
				zeroMutants: outcome.zeroMutants,
				filesSkippedOverCap: skipped,
				filesUncovered: uncovered,
				rangesTotal: allPatterns.length,
				testsRun: tests,
			}),
		);
		process.exit(0);
	}
	const allowedMutants = estimateAffordableMutants({
		remainingMs: remainingBudgetMs(),
		concurrency: CONCURRENCY,
		dryRunMs: cost.dryRunMs,
	});
	if (cost.totalMutants > allowedMutants) {
		const keepRangeCount = Math.max(
			1,
			Math.min(
				maxRanges,
				Math.floor((allPatterns.length * allowedMutants) / cost.totalMutants),
			),
		);
		const resampled = sampleRangesDeterministically(
			allPatterns,
			keepRangeCount,
			sha,
		);
		patterns = resampled.selected;
		sampled = true;
		console.log(
			`mutation diff: measured ${cost.totalMutants} mutant(s) at ${cost.dryRunMs}ms/dry-run; the remaining budget affords ~${allowedMutants}; sampled ${patterns.length} of ${allPatterns.length} ranges deterministically (seed ${sha})`,
		);
	} else {
		console.log(
			`mutation diff: measured ${cost.totalMutants} mutant(s) at ${cost.dryRunMs}ms/dry-run; within the remaining budget, no sampling needed`,
		);
	}
}

const configFile = writeRunConfig(tests);

// round 2 R2-1: a deterministic sample can land entirely on ranges Stryker's
// mutator set has none for -- a real #3579 replay at a 15-minute budget
// sampled 1 of 99 ranges (`clients/instance-reaper.js:931-931`, a shorthand-
// property line), while the other 98 together held all 710 measured
// mutants. When the measurement KNOWS mutants exist elsewhere, retry with a
// fresh sample that excludes every range already proven empty (planResample)
// instead of reporting that verdict for the run's very first, possibly
// unlucky, sample. Each attempt costs a full Stryker run, so this is bounded
// by both MAX_RESAMPLE_ATTEMPTS and the shrinking remaining budget.
const MAX_RESAMPLE_ATTEMPTS = 3;
const triedPatternSet = new Set();
let triedPatterns = [];
let attempt = 0;

for (;;) {
	for (const pattern of patterns) triedPatternSet.add(pattern);
	triedPatterns = [...triedPatternSet];
	// The incremental file is rewritten below regardless (force:true, round 2
	// T4), but clearing it before every attempt means neither a run that never
	// reaches Stryker nor a PRIOR (empty) attempt in this same resample loop
	// leaves a STALE file for the next attempt, or some later, unrelated local
	// invocation, to trip over.
	rmSync(INCREMENTAL_PATH, { force: true });

	console.log(`mutation diff: mutating ${patterns.join(", ")}`);
	console.log(`mutation diff: running related tests ${tests.join(", ")}`);
	console.log(`mutation diff: budget ${budgetMinutes} minute(s)`);
	const result = spawnSync(
		"node_modules/.bin/stryker",
		["run", "--mutate", patterns.join(","), configFile],
		{
			stdio: "inherit",
			encoding: "utf8",
			timeout: remainingBudgetMs(),
			killSignal: "SIGTERM",
		},
	);

	if (result.error || result.status !== 0) {
		// round 2 S2: a budget kill (or any other interrupt) can still leave a
		// PARTIAL result Stryker itself saved (`.stryker/incremental.json`,
		// force:true keeps `incremental` enabled so this write-on-interrupt path
		// stays live -- see buildRunConfig). Report what DID run, labelled
		// partial, instead of a blanket "no mutants evaluated" that discards
		// real signal the run already paid for. No retry on an interrupt: the
		// remaining budget that would fund one is exactly what just ran out.
		let partialMutants = [];
		let partialReport = null;
		let partialCounts = {};
		let partialScore = "n/a";
		if (existsSync(INCREMENTAL_PATH)) {
			try {
				partialReport = JSON.parse(readFileSync(INCREMENTAL_PATH, "utf8"));
				({
					mutants: partialMutants,
					counts: partialCounts,
					score: partialScore,
				} = augmentAndSummarize(partialReport, compiledIndexByJsFile));
			} catch (error) {
				console.error(
					`mutation diff: partial report unreadable: ${error.message}`,
				);
			}
		}
		// round 2 R2-2: routed through decideMutationOutcome, the same
		// function the two zero-mutant branches use, so a mutation of any of
		// the three original independent conditions is caught by one shared
		// test surface rather than none.
		const outcome = decideMutationOutcome({
			interrupted: true,
			mutants: partialMutants,
			sampled,
			rangesEvaluated: triedPatterns.length,
			rangesTotal: allPatterns.length,
			totalMutants: costEstimate?.totalMutants ?? null,
			failureReason: describeStrykerFailure(result, budgetMinutes),
			partialReason: describePartialInterruptCause(result, budgetMinutes),
		});
		console.error(describeStrykerFailure(result, budgetMinutes));
		if (outcome.partial) {
			console.log(
				`mutation diff: partial report -- ${outcome.partial.evaluated} of ${outcome.partial.total ?? "an unknown total of"} mutant(s) evaluated before the interrupt`,
			);
			logSurvivors(partialMutants);
			writeReport(
				partialReport,
				baseMeta({
					zeroMutants: null,
					partial: outcome.partial,
					filesSkippedOverCap: skipped,
					filesUncovered: uncovered,
					rangesTotal: allPatterns.length,
					rangesEvaluated: triedPatterns.length,
					rangesSampled: sampled,
					testsRun: tests,
					counts: partialCounts,
					score: partialScore,
				}),
			);
		} else {
			writeReport(
				null,
				baseMeta({
					zeroMutants: outcome.zeroMutants,
					filesSkippedOverCap: skipped,
					filesUncovered: uncovered,
					rangesTotal: allPatterns.length,
					rangesEvaluated: triedPatterns.length,
					rangesSampled: sampled,
					testsRun: tests,
				}),
			);
		}
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

	let strykerReport;
	try {
		strykerReport = JSON.parse(readFileSync(REPORT_PATH, "utf8"));
	} catch (error) {
		console.error(`mutation diff: report unreadable: ${error.message}`);
		process.exit(1);
	}
	// The mutation-report schema keys mutants by file; the entries themselves
	// carry no file name (spike 2026-09-09 printed `survived: undefined:59`).
	const { mutants, counts, score } = augmentAndSummarize(
		strykerReport,
		compiledIndexByJsFile,
	);
	// round 4 R3-1: computed ONCE, right after augmentAndSummarize, and every
	// branch below reads ITS decision (`outcome.zeroMutants`) rather than
	// re-deriving `mutants.length > 0` as an inline duplicate -- the review
	// found that raw duplicate removable (mutated to `>= 0`) with all four
	// mutation test files still green, since nothing but this one `if` ever
	// looked at it. `renderMutationMarkdown` (`scripts/lib/mutation-report-
	// render.mjs`) also backstops this at the render seam independent of the
	// driver, in case a later branch reintroduces the same gap.
	const outcome = decideMutationOutcome({
		interrupted: false,
		mutants,
		sampled,
		rangesEvaluated: triedPatterns.length,
		rangesTotal: allPatterns.length,
		totalMutants: costEstimate?.totalMutants ?? null,
	});

	if (!outcome.zeroMutants) {
		console.log(`mutation diff score: ${score}`);
		console.log(`mutation diff counts: ${JSON.stringify(counts)}`);
		logSurvivors(mutants);
		writeReport(
			strykerReport,
			baseMeta({
				zeroMutants: null,
				filesSkippedOverCap: skipped,
				filesUncovered: uncovered,
				filesNoSourceMap: compiledSkippedNoMap,
				filesNoMutableLines: compiledSkippedNoLines,
				rangesTotal: allPatterns.length,
				rangesEvaluated: triedPatterns.length,
				rangesSampled: sampled,
				testsRun: tests,
				counts,
				score,
			}),
		);
		break;
	}

	// round 2 S1: a full run that instruments and executes 0 mutants (every
	// changed-line token this diff produced is one Stryker's mutator set has
	// no operator for -- a property-shorthand addition, a destructuring
	// entry) must not render as a normal, scoreless "clean pass". round 2
	// R2-1: before reporting that, try a fresh sample if this run's sample is
	// the reason, not the changed lines themselves.
	const plan = sampled
		? planResample({
				allPatterns,
				triedPatterns,
				keepRangeCount: patterns.length,
				seed: sha,
				attemptsSoFar: attempt,
				maxAttempts: MAX_RESAMPLE_ATTEMPTS,
			})
		: { retry: false };
	attempt += 1;

	if (!plan.retry || remainingBudgetMs() <= 0) {
		console.log(
			`mutation diff: no mutants evaluated; ${outcome.zeroMutants.reason}`,
		);
		writeReport(
			strykerReport,
			baseMeta({
				zeroMutants: outcome.zeroMutants,
				filesSkippedOverCap: skipped,
				filesUncovered: uncovered,
				filesNoSourceMap: compiledSkippedNoMap,
				filesNoMutableLines: compiledSkippedNoLines,
				rangesTotal: allPatterns.length,
				rangesEvaluated: triedPatterns.length,
				rangesSampled: sampled,
				testsRun: tests,
			}),
		);
		process.exit(0);
	}

	console.log(
		`mutation diff: ${patterns.length} sampled range(s) held 0 mutants; retrying with ${plan.patterns.length} more of the ${allPatterns.length - triedPatterns.length} not yet tried (attempt ${attempt} of ${MAX_RESAMPLE_ATTEMPTS})`,
	);
	patterns = plan.patterns;
}

console.log("mutation diff: completed");
