export declare const DEFAULT_MAX_FILES: 6;
export declare const DEFAULT_MAX_RANGES: 40;
export declare const MUTATION_BUDGET_MINUTES: 60;
export declare function capMutationFiles(
	files: string[],
	maxFiles?: number,
): { selected: string[]; skipped: string[] };
export declare function formatCapNotice(
	selectedCount: number,
	totalCount: number,
	skipped: string[],
): string;
export declare const isScriptMutationFile: (file: string) => boolean;
export declare const isCompiledMutationSource: (file: string) => boolean;
export declare const isMutationSourceFile: (file: string) => boolean;
export declare const compiledJsPath: (file: string) => string;
export declare function mapRelatedTests(
	changedFiles: string[],
	options?: {
		testFiles?: string[];
		readFile?: (file: string) => string;
	},
): {
	related: Map<string, Set<string>>;
	covered: string[];
	uncovered: string[];
	tests: string[];
};
export declare function parseChangedLineRanges(
	diffText: string,
): Map<string, Array<[number, number]>>;
export declare function mutationRangePatterns(
	files: string[],
	rangesByFile: Map<string, Array<[number, number]>>,
): string[];
export declare function describeStrykerFailure(
	result: {
		status: number | null;
		signal?: NodeJS.Signals | null;
		error?: Error & { code?: string };
	},
	budgetMinutes: number,
): string;
export declare function sampleRangesDeterministically(
	patterns: string[],
	limit: number,
	seed: string,
): { selected: string[]; sampled: boolean };
export declare function extractSnippet(
	sourceLines: string[],
	location:
		| {
				start: { line: number; column: number };
				end: { line: number; column: number };
		  }
		| undefined,
): string | undefined;
export declare function buildRunConfig(
	baseConfig: Record<string, unknown> & { commandRunner?: object },
	options: { command: string },
): Record<string, unknown>;
export declare function parseDryRunCost(
	output: string,
): { totalMutants: number; dryRunMs: number } | null;
export declare function estimateAffordableMutants(args: {
	remainingMs: number;
	concurrency: number;
	dryRunMs: number;
	safetyFactor?: number;
}): number;
export declare function dedupePatterns(patterns: string[]): string[];
export declare function augmentAndSummarize(
	strykerReport: { files?: Record<string, { mutants?: any[] }> },
	compiledIndexByJsFile: Map<string, { index: object; tsFile: string }>,
	options?: { readFile?: (file: string) => string },
): { mutants: any[]; counts: Record<string, number>; score: string };
