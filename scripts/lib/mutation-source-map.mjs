/**
 * Maps line numbers between a `.ts` source and its tsc-compiled `.js` output
 * through the source map tsc emits, in both directions (#3531):
 *
 *  - forward: a PR's changed `.ts` line ranges -> the `.js` line ranges
 *    Stryker should mutate (tests actually execute the compiled `.js`, never
 *    the `.ts`, so that is what must be mutated).
 *  - reverse: a surviving mutant's `.js` file:line -> the `.ts` file:line a
 *    fixer or reviewer reads and edits.
 *
 * tsc's per-statement source maps are SPARSE: a blank line, a comment, or a
 * type-only construct (an `interface`, a `type` alias, a type-only import)
 * emits no line at all, so most `.ts` lines have no direct mapping entry.
 * Verified against a real build (clients/atomic-write.ts, 2026-09-26): 216
 * `.ts` lines compile to 189 `.js` lines with only 290 mapping segments, and
 * tsc's emit is NOT line-preserving in general -- e.g.
 * clients/actionable-warnings.ts (2258 lines) compiles to 1610 `.js` lines.
 * A naive "same line number" mapping would misattribute most mutants.
 *
 * Both directions are answered from ONE ascending index built from the
 * decoded mapping segments: entries are sorted by generated line for the
 * reverse direction and by original line for the forward direction, and a
 * changed range is resolved to "the nearest mapped statement at or after
 * (forward-start) / at or before (reverse)" the queried line -- the same
 * rule a human reading the sparse map by eye would apply, and the one a
 * real decoded map from clients/atomic-write.ts confirms line-for-line
 * (js:100 -> ts:122, content-verified) against `eachMapping`'s raw segments.
 */
import {
	GREATEST_LOWER_BOUND,
	originalPositionFor,
	TraceMap,
	eachMapping,
} from "@jridgewell/trace-mapping";

/**
 * Construct the `TraceMap` a column-aware reverse lookup needs
 * (`mapGeneratedLineToOriginal`'s `generatedColumn` argument). Centralized
 * here so `TraceMap` is constructed from one place in this module rather
 * than importing `@jridgewell/trace-mapping` a second time at the call
 * site.
 *
 * @param {object} rawMap parsed source map JSON
 */
export function createTracer(rawMap) {
	return new TraceMap(rawMap);
}

/**
 * Decode a tsc-emitted source map (parsed v3 JSON) into ascending
 * `{ generatedLine, originalLine }` rows. tsc emits exactly one `sources`
 * entry per compiled file, so the source name itself is not needed here.
 * Kept separate from the pure line-index math below so tests can hand
 * `buildLineIndex` literal rows instead of encoding real VLQ mappings.
 *
 * @param {object} rawMap parsed source map JSON
 * @returns {Array<{generatedLine: number, originalLine: number}>}
 */
export function decodeSourceMapRows(rawMap) {
	const tracer = new TraceMap(rawMap);
	const rows = [];
	eachMapping(tracer, (mapping) => {
		if (mapping.originalLine != null) {
			rows.push({
				generatedLine: mapping.generatedLine,
				originalLine: mapping.originalLine,
			});
		}
	});
	return rows;
}

/**
 * Build the two sorted, first-occurrence-deduped views of a decoded source
 * map used for line translation in each direction. tsc emits statements in
 * source order, so a well-formed map is monotonic in both dimensions; each
 * view is sorted defensively regardless, so translation stays correct (a
 * best-effort nearest match, never a crash) even if that assumption is ever
 * violated by a future TypeScript emit change.
 *
 * @param {Array<{generatedLine: number, originalLine: number}>} rows
 */
export function buildLineIndex(rows) {
	const byOriginal = new Map();
	const byGenerated = new Map();
	for (const { generatedLine, originalLine } of rows) {
		const existing = byOriginal.get(originalLine);
		if (existing === undefined || generatedLine < existing) {
			byOriginal.set(originalLine, generatedLine);
		}
		if (!byGenerated.has(generatedLine)) {
			byGenerated.set(generatedLine, originalLine);
		}
	}
	return {
		forward: [...byOriginal.entries()].sort((a, b) => a[0] - b[0]),
		reverse: [...byGenerated.entries()].sort((a, b) => a[0] - b[0]),
	};
}

/** First entry whose key is >= target, or null. */
function ceiling(sortedPairs, target) {
	let lo = 0;
	let hi = sortedPairs.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (sortedPairs[mid][0] >= target) hi = mid;
		else lo = mid + 1;
	}
	return lo < sortedPairs.length ? sortedPairs[lo] : null;
}

/** Last entry whose key is <= target, or null. */
function floor(sortedPairs, target) {
	let lo = 0;
	let hi = sortedPairs.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (sortedPairs[mid][0] <= target) lo = mid + 1;
		else hi = mid;
	}
	return lo > 0 ? sortedPairs[lo - 1] : null;
}

/**
 * Map a PR's changed `.ts` line ranges (1-based, inclusive, HEAD-side) to
 * the `.js` line ranges tsc emitted for them. A range whose lines carry no
 * emitted code at all (a type-only or comment-only hunk) contributes
 * nothing: there is no compiled statement there for Stryker to mutate, so
 * it is silently dropped rather than approximated onto unrelated code.
 *
 * The end of a mapped range extends up to (but not including) the next
 * mapped statement after the hunk, so a changed line's full generated
 * body -- e.g. a multi-line call a one-line `.ts` edit expands into -- is
 * covered; `totalGeneratedLines` bounds it when the hunk reaches the last
 * statement in the file.
 *
 * @param {{forward: Array<[number, number]>}} index from buildLineIndex
 * @param {Array<[number, number]>} ranges changed `.ts` ranges
 * @param {number} totalGeneratedLines line count of the compiled `.js`
 * @returns {Array<[number, number]>} `.js` ranges
 */
export function mapRangesToGenerated(index, ranges, totalGeneratedLines) {
	const out = [];
	for (const [start, end] of ranges) {
		const startEntry = ceiling(index.forward, start);
		if (!startEntry || startEntry[0] > end) continue;
		const afterEnd = ceiling(index.forward, end + 1);
		const genStart = startEntry[1];
		const genEnd = afterEnd
			? Math.max(genStart, afterEnd[1] - 1)
			: Math.max(genStart, totalGeneratedLines);
		out.push([genStart, genEnd]);
	}
	return out;
}

/**
 * Map one `.js` survivor location back to the `.ts` source line, column-
 * aware when a column and a `tracer` (from `createTracer`) are given.
 *
 * Several `.ts` statements collapsed onto one generated line (tsc emits a
 * per-token, not just per-line, mapping there) report the WRONG `.ts` line
 * under a line-only lookup: verified against a real build,
 * `clients/actionable-warnings-logger.js:9` holds `.ts` lines 10-12 on one
 * line, and `originalPositionFor` at the real Stryker mutant columns of
 * `128 * 1024` and `??` resolves to `.ts:11` and `.ts:12` respectively --
 * both would read as `.ts:10` (the line's first mapped statement) under
 * the line-only fallback below.
 *
 * `originalPositionFor` only searches WITHIN the queried generated line
 * (verified: it returns `null` for a line with no segment of its own, never
 * falling back to a preceding line the way a human reading the sparse map
 * would), so a continuation line -- the body of a multi-line call, a
 * closing brace -- falls through to the same "nearest preceding mapped
 * statement" line index `mapRangesToGenerated` uses, giving every caller
 * one answer regardless of which case its survivor lands in.
 *
 * @param {{reverse: Array<[number, number]>, tracer?: object}} index from
 *   buildLineIndex, with `tracer` (from createTracer) added for the
 *   column-aware path
 * @param {number} generatedLine
 * @param {number} [generatedColumn] 0-based; Stryker's own locations are
 *   1-based, so a caller passes `mutant.location.start.column - 1`
 * @returns {number | null}
 */
export function mapGeneratedLineToOriginal(
	index,
	generatedLine,
	generatedColumn,
) {
	if (generatedColumn != null && index.tracer) {
		const position = originalPositionFor(index.tracer, {
			line: generatedLine,
			column: generatedColumn,
			bias: GREATEST_LOWER_BOUND,
		});
		if (position.line != null) return position.line;
	}
	const entry = floor(index.reverse, generatedLine);
	return entry ? entry[1] : null;
}

/**
 * Line count of compiled text, robust to a missing/extra trailing newline
 * (both are common depending on how the file was produced).
 *
 * @param {string} content
 */
export function countLines(content) {
	if (content.length === 0) return 0;
	const lines = content.split("\n");
	return content.endsWith("\n") ? lines.length - 1 : lines.length;
}
