import { encode } from "@jridgewell/sourcemap-codec";
import type { SourceMapMappings } from "@jridgewell/sourcemap-codec";
import { describe, expect, it } from "vitest";
import {
	buildLineIndex,
	countLines,
	createTracer,
	decodeSourceMapRows,
	mapGeneratedLineToOriginal,
	mapRangesToGenerated,
} from "../../scripts/lib/mutation-source-map.mjs";

/**
 * Builds a v3 source map whose generated (`.js`) line N (1-based) maps to
 * the given original (`.ts`) line, for exactly the listed N's -- every
 * other generated line is left unmapped, the same sparsity a real tsc emit
 * has for blank/comment/type-only lines (module header comment, #3531).
 */
function fixtureSourceMap(mappedByGeneratedLine: Record<number, number>) {
	const maxGenLine = Math.max(
		...Object.keys(mappedByGeneratedLine).map(Number),
	);
	const decoded: SourceMapMappings = [];
	for (let genLine = 1; genLine <= maxGenLine; genLine += 1) {
		const originalLine = mappedByGeneratedLine[genLine];
		decoded.push(
			originalLine === undefined ? [] : [[0, 0, originalLine - 1, 0]],
		);
	}
	return {
		version: 3,
		sources: ["fixture.ts"],
		names: [],
		mappings: encode(decoded),
	};
}

describe("decodeSourceMapRows", () => {
	it("decodes a real v3 map into ascending generated/original line rows", () => {
		// Recurrence: a real tsc source map is sparse (blank/comment/type-only
		// lines emit no segment at all) -- the decoder must skip those,
		// not invent a row for every generated line.
		const map = fixtureSourceMap({ 1: 1, 3: 5, 4: 10, 8: 20 });
		expect(decodeSourceMapRows(map)).toEqual([
			{ generatedLine: 1, originalLine: 1 },
			{ generatedLine: 3, originalLine: 5 },
			{ generatedLine: 4, originalLine: 10 },
			{ generatedLine: 8, originalLine: 20 },
		]);
	});
});

describe("mapRangesToGenerated (forward: .ts hunk -> .js range)", () => {
	const index = buildLineIndex([
		{ generatedLine: 1, originalLine: 1 },
		{ generatedLine: 3, originalLine: 5 },
		{ generatedLine: 4, originalLine: 10 },
		{ generatedLine: 8, originalLine: 20 },
	]);

	it("maps a changed range to the generated line of its own statement, extended to just before the next one", () => {
		// ts lines 5-9 are ALL covered by the one statement that starts at
		// js line 3 (the next mapped statement is ts:10 -> js:4), so the
		// hunk's generated range stops at js:3, not js:4.
		expect(mapRangesToGenerated(index, [[5, 9]], 8)).toEqual([[3, 3]]);
	});

	it("drops a hunk whose lines carry no emitted code at all", () => {
		// Recurrence: ts lines 2-4 sit between the anchor at ts:1 and the
		// next real statement at ts:5 -- a type-only/comment-only gap. A
		// hunk entirely inside it must contribute NO mutation range, not an
		// approximated one, since Stryker has nothing there to mutate.
		expect(mapRangesToGenerated(index, [[2, 4]], 8)).toEqual([]);
	});

	it("bounds the last mapped statement's range at the file's total generated lines", () => {
		expect(mapRangesToGenerated(index, [[15, 25]], 8)).toEqual([[8, 8]]);
	});

	it("maps several ranges independently in one call", () => {
		expect(
			mapRangesToGenerated(
				index,
				[
					[1, 1],
					[10, 12],
				],
				8,
			),
		).toEqual([
			[1, 2],
			[4, 7],
		]);
	});
});

describe("mapGeneratedLineToOriginal (reverse: survivor .js:line -> .ts:line)", () => {
	const index = buildLineIndex([
		{ generatedLine: 1, originalLine: 1 },
		{ generatedLine: 3, originalLine: 5 },
		{ generatedLine: 4, originalLine: 10 },
		{ generatedLine: 8, originalLine: 20 },
	]);

	it("attributes an unmapped generated line to its nearest preceding mapped statement", () => {
		// Recurrence: js:6 has no mapping of its own (a continuation line of
		// the ts:10 statement's compiled body) -- the survivor still belongs
		// to ts:10, the statement that most recently started.
		expect(mapGeneratedLineToOriginal(index, 6)).toBe(10);
	});

	it("returns the exact mapped line when the generated line is itself a mapped statement start", () => {
		expect(mapGeneratedLineToOriginal(index, 4)).toBe(10);
	});

	it("returns null for a generated line before every mapped statement", () => {
		expect(mapGeneratedLineToOriginal(index, 0)).toBeNull();
	});
});

describe("mapGeneratedLineToOriginal, column-aware (#3531 round 2 S3)", () => {
	// Mirrors a real collapsed multi-line expression verified against a real
	// build: clients/actionable-warnings-logger.ts's `Math.max(\n\t128 * 1024,
	// \n\tNumber.parseInt(...) ?? ...\n)` (ts lines 10-12) compiles to one js
	// line (9) with per-token segments -- `128 * 1024` at ts:11, `??` at
	// ts:12 -- not one line-level "ts:10" segment. Columns are 0-based here to
	// match `sourcemap-codec`'s `encode`; production passes
	// `mutant.location.start.column - 1` since Stryker's own columns are
	// 1-based (verified separately in stryker-diff.test.ts).
	const rawMap = {
		version: 3,
		sources: ["fixture.ts"],
		names: [],
		mappings: encode([
			[], // js line 1: no mapping at all (a continuation line -- e.g. the
			// closing `);` of a call whose head is on the next mapped line)
			[
				[0, 0, 9, 0], // js:2 col 0 -> ts:10 col 0 (the call's own head)
				[10, 0, 10, 1], // js:2 col 10 -> ts:11 col 1 (`128 * 1024`)
				[21, 0, 11, 2], // js:2 col 21 -> ts:12 col 2 (`??`)
			],
		]),
	};
	const tracer = createTracer(rawMap);
	const index = { ...buildLineIndex(decodeSourceMapRows(rawMap)), tracer };

	it("resolves two different mutants on the SAME generated line to their own .ts lines", () => {
		expect(mapGeneratedLineToOriginal(index, 2, 10)).toBe(11);
		expect(mapGeneratedLineToOriginal(index, 2, 21)).toBe(12);
	});

	it("resolves a column past the last segment on the line to that last segment (GREATEST_LOWER_BOUND)", () => {
		expect(mapGeneratedLineToOriginal(index, 2, 30)).toBe(12);
	});

	it("falls back to the nearest preceding mapped statement when the exact line has no segment of its own", () => {
		// js:1 carries no mapping; the line-based fallback attributes it to the
		// nearest preceding mapped statement, same as the no-column API.
		expect(mapGeneratedLineToOriginal(index, 1, 0)).toBeNull();
	});

	it("falls back to the line-based lookup when no column is given, even with a tracer present", () => {
		expect(mapGeneratedLineToOriginal(index, 2)).toBe(10);
	});

	it("falls back to the line-based lookup when no tracer is present, even with a column given", () => {
		const noTracerIndex = buildLineIndex(decodeSourceMapRows(rawMap));
		expect(mapGeneratedLineToOriginal(noTracerIndex, 2, 21)).toBe(10);
	});
});

describe("countLines", () => {
	it("counts lines regardless of a trailing newline", () => {
		expect(countLines("a\nb\nc\n")).toBe(3);
		expect(countLines("a\nb\nc")).toBe(3);
		expect(countLines("")).toBe(0);
		expect(countLines("only one line, no newline")).toBe(1);
	});
});
