import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const IMPORT_SPECIFIER_RE =
	/(?:from\s+|import\s*(?:\(\s*)?|require\(\s*)["']([^"']+)["']/g;

export const DEFAULT_MAX_FILES = 6;

/**
 * Ceiling on the combined mutate-pattern (changed-range) population, across
 * both scripts and compiled sources, in one PR's mutation run. `--max-files`
 * bounds how many CHANGED FILES enter the run; a single large file's diff can
 * still produce far more ranges than the budget affords, so this bounds the
 * ranges themselves.
 */
export const DEFAULT_MAX_RANGES = 40;

/**
 * Wall-clock bound the driver puts on the Stryker child, in minutes. It must
 * stay strictly below .github/workflows/mutation.yml's `timeout-minutes`, or
 * the runner cancels the job first and the driver never gets to say that it
 * evaluated nothing (advisory run 36098718085). The margin also covers
 * `npm ci`, `npm run build`, Stryker's in-place sandbox restore on SIGTERM,
 * and the report upload.
 */
export const MUTATION_BUDGET_MINUTES = 60;

// `git diff --unified=0` headers. Only the "+" side is used: it numbers lines
// in HEAD, which is the tree Stryker mutates in place.
const DIFF_FILE_RE = /^\+\+\+ b\/(.+)$/;
const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

export const isScriptMutationFile = (file) =>
	/^scripts\/.*\.mjs$/.test(file) && !file.endsWith(".test.mjs");

/**
 * A `.ts` source this lane mutates through its compiled `.js` output (#3531
 * rescope): `clients/`, `tools/`, `mcp/`, and the root `index.ts`. Tests
 * execute the compiled `.js`, never the `.ts`, so these are mutated there
 * (mutation-source-map.mjs maps the PR's `.ts` diff onto it) and reported
 * back at `.ts` file:line.
 */
export const isCompiledMutationSource = (file) =>
	(/^(?:clients|tools|mcp)\/.*\.ts$/.test(file) || file === "index.ts") &&
	!file.endsWith(".test.ts") &&
	!file.endsWith(".d.ts");

export const isMutationSourceFile = (file) =>
	isScriptMutationFile(file) || isCompiledMutationSource(file);

/**
 * The compiled sibling `tsc --project tsconfig.build.json` emits for a
 * `.ts` mutation source. No `outDir` is configured, so tsc writes `.js`
 * (and, under tsconfig.mutation.json, `.js.map`) next to the `.ts` source
 * (verified: `clients/atomic-write.js` sits beside `clients/atomic-write.ts`
 * after a real build, 2026-09-26).
 */
export const compiledJsPath = (file) => `${file.slice(0, -3)}.js`;

function collectTestFiles(dir, out = []) {
	if (!existsSync(dir)) return out;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) collectTestFiles(full, out);
		else if (entry.name.endsWith(".test.ts")) out.push(full);
	}
	return out;
}

function extractRelativeSpecifiers(content) {
	const specifiers = [];
	IMPORT_SPECIFIER_RE.lastIndex = 0;
	let match = IMPORT_SPECIFIER_RE.exec(content);
	while (match) {
		if (match[1].startsWith(".")) specifiers.push(match[1]);
		match = IMPORT_SPECIFIER_RE.exec(content);
	}
	return specifiers;
}

function normalized(file) {
	return path
		.resolve(file)
		.replace(/\\/g, "/")
		.replace(/\.(?:mjs|js|cjs|ts)$/, "");
}

export function capMutationFiles(files, maxFiles = DEFAULT_MAX_FILES) {
	if (!Number.isInteger(maxFiles) || maxFiles < 0) {
		throw new RangeError("maxFiles must be a non-negative integer");
	}
	const ordered = [...files].sort();
	return {
		selected: ordered.slice(0, maxFiles),
		skipped: ordered.slice(maxFiles),
	};
}

/**
 * Group the new-side changed line ranges of a `git diff --unified=0` payload by
 * file. An omitted hunk count means one line; a deletion-only hunk ("+c,0", and
 * "+0,0" at the top of a file) collapses to the single line at the deletion
 * point, because Stryker rejects an inverted or sub-line-1 mutation range during
 * options validation.
 *
 * @param {string} diffText
 * @returns {Map<string, Array<[number, number]>>}
 */
export function parseChangedLineRanges(diffText) {
	const ranges = new Map();
	// git always emits the "+++ b/<path>" header before that file's hunks, so
	// `file` is set by the time a hunk header matches.
	let file;
	for (const line of diffText.split("\n")) {
		const fileMatch = DIFF_FILE_RE.exec(line);
		if (fileMatch) {
			file = fileMatch[1];
			ranges.set(file, []);
			continue;
		}
		const hunk = HUNK_HEADER_RE.exec(line);
		if (!hunk) continue;
		const newStart = Number(hunk[1]);
		const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
		const start = Math.max(1, newStart);
		ranges.get(file).push([start, Math.max(start, newStart + count - 1)]);
	}
	return ranges;
}

/**
 * Turn the selected files and their changed ranges into Stryker `--mutate`
 * patterns. A bare path means "mutate the whole file", which is the 2220-mutant
 * population that made the lane evaluate nothing, so a file with no changed
 * ranges contributes no pattern at all.
 *
 * @param {string[]} files
 * @param {Map<string, Array<[number, number]>>} rangesByFile
 * @returns {string[]}
 */
export function mutationRangePatterns(files, rangesByFile) {
	return files.flatMap((file) =>
		(rangesByFile.get(file) ?? []).map(
			([start, end]) => `${file}:${start}-${end}`,
		),
	);
}

/**
 * Deterministically sample `--mutate` patterns down to `limit` when a PR's
 * changed lines produce more than the run's range budget affords. Seeded by
 * the head SHA (not `Math.random()`): the same PR head always samples the
 * same subset, so a re-run reports the same survivors instead of a
 * different, non-reproducible slice each time; a different head (a new
 * commit) samples differently. Order-independent of the input: patterns are
 * ranked by `sha256(seed:pattern)` rather than by array position, so
 * reordering the same changed-file set (a different `git diff` file order)
 * still selects the same sample.
 *
 * @param {string[]} patterns
 * @param {number} limit
 * @param {string} seed typically the head SHA
 * @returns {{selected: string[], sampled: boolean}}
 */
export function sampleRangesDeterministically(patterns, limit, seed) {
	if (patterns.length <= limit) return { selected: patterns, sampled: false };
	const ranked = patterns
		.map((pattern) => ({
			pattern,
			key: createHash("sha256").update(`${seed}:${pattern}`).digest("hex"),
		}))
		.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	const keep = new Set(ranked.slice(0, limit).map((entry) => entry.pattern));
	return {
		selected: patterns.filter((pattern) => keep.has(pattern)),
		sampled: true,
	};
}

/**
 * The pre-mutation source text a mutant's location spans, read from the
 * (by the time the driver calls this, restored-to-original) source file --
 * Stryker's own report schema stores only the replacement, never what it
 * replaced. Columns are 1-based (verified against a real report: a
 * ConditionalExpression mutant at columns 6-49 of
 * `scripts/lib/stryker-diff.mjs:56` sliced to exactly
 * `!Number.isInteger(maxFiles) || maxFiles < 0`, 2026-09-26). A multi-line
 * span is truncated to its first line with a marker rather than joined,
 * since joining would misrepresent the original formatting.
 *
 * @param {string[]} sourceLines
 * @param {{start: {line:number, column:number}, end: {line:number, column:number}} | undefined} location
 */
export function extractSnippet(sourceLines, location) {
	if (!location?.start || !location?.end) return undefined;
	const { start, end } = location;
	const line = sourceLines[start.line - 1] ?? "";
	if (start.line === end.line) {
		return line.slice(start.column - 1, end.column - 1);
	}
	return `${line.slice(start.column - 1)} … (multi-line)`;
}

/**
 * Describe a Stryker child that produced no mutation result. `spawnSync` marks
 * an expired budget with `error.code === "ETIMEDOUT"`; `signal` is null when the
 * child exits on the signal itself, which Stryker's UnexpectedExitHandler does,
 * so the signal is not a usable discriminator.
 *
 * @param {{status: number|null, signal?: string|null, error?: Error & {code?: string}}} result
 * @param {number} budgetMinutes
 */
export function describeStrykerFailure(result, budgetMinutes) {
	const cause =
		result.error?.code === "ETIMEDOUT"
			? `the ${budgetMinutes}-minute mutation budget expired before Stryker produced a result`
			: `dry run or mutation execution failed (Stryker status ${result.status ?? "unknown"}${result.error ? `: ${result.error.message}` : ""})`;
	return `mutation diff: no mutants evaluated; ${cause}`;
}

export function formatCapNotice(selectedCount, totalCount, skipped) {
	return `capped: ${selectedCount} of ${totalCount} changed files mutated; skipped: ${skipped.join(", ")}`;
}

/**
 * The conventional test-file location a mutation source's basename maps to,
 * mirroring the file's top-level directory: `scripts/lib/ci-checks.mjs` ->
 * `tests/scripts/ci-checks.test.ts`, `clients/lsp/inferred-project.ts` ->
 * `tests/clients/inferred-project.test.ts`. This is only a supplementary
 * signal on top of the relative-import scan below: `clients/` and `tools/`
 * mirror this convention unevenly (some tests nest under the source's own
 * subdirectory, e.g. `tests/clients/dispatch/rules/`; some sources have no
 * directly-named test at all and are covered only through the import scan),
 * so a miss here is expected and never treated as "uncovered" on its own.
 *
 * @param {string} file
 */
function conventionalTestSibling(file) {
	const [topDir] = file.split("/");
	const base = path.basename(file).replace(/\.(?:mjs|ts)$/, "");
	return topDir === file
		? `tests/${base}.test.ts`
		: `tests/${topDir}/${base}.test.ts`;
}

/**
 * Select tests that cover changed mutation sources (scripts/**\/*.mjs and
 * the compiled-source classes in isCompiledMutationSource) through one-hop
 * relative imports or the conventional tests/<dir>/<name>.test.ts sibling.
 * Compiled sources are matched the same way scripts are: test files import
 * them with a relative specifier (typically ending in `.js`, since that is
 * what TypeScript's `nodenext` resolution and the repo's own tests use to
 * reach a compiled `clients/*.ts` module -- e.g. `tests/index-wiring.test.ts`
 * imports `../index.js`), which `normalized()` compares extension-agnostically.
 *
 * @param {string[]} changedFiles
 * @param {{ testFiles?: string[], readFile?: (file: string) => string }} [options]
 */
export function mapRelatedTests(
	changedFiles,
	{
		testFiles = collectTestFiles("tests"),
		readFile = (file) => readFileSync(file, "utf8"),
	} = {},
) {
	const sources = changedFiles.filter(isMutationSourceFile);
	const related = new Map(sources.map((file) => [file, new Set()]));
	const testContents = testFiles.map((test) => {
		try {
			return [test, readFile(test)];
		} catch {
			return [test, null];
		}
	});

	for (const file of sources) {
		const sibling = conventionalTestSibling(file);
		if (testFiles.some((test) => normalized(test) === normalized(sibling))) {
			related.get(file).add(sibling);
		}
		const target = normalized(file);
		for (const [test, content] of testContents) {
			if (content === null) continue;
			for (const specifier of extractRelativeSpecifiers(content)) {
				const imported = normalized(
					path.resolve(path.dirname(test), specifier),
				);
				if (imported === target) related.get(file).add(test);
			}
		}
	}

	return {
		related,
		covered: sources.filter((file) => related.get(file).size > 0),
		uncovered: sources.filter((file) => related.get(file).size === 0),
		tests: [...new Set([...related.values()].flatMap((files) => [...files]))],
	};
}
