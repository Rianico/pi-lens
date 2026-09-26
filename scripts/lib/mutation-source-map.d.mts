export declare function createTracer(rawMap: object): object;
export declare function decodeSourceMapRows(
	rawMap: object,
): Array<{ generatedLine: number; originalLine: number }>;
export declare function buildLineIndex(
	rows: Array<{ generatedLine: number; originalLine: number }>,
): {
	forward: Array<[number, number]>;
	reverse: Array<[number, number]>;
};
export declare function mapRangesToGenerated(
	index: { forward: Array<[number, number]> },
	ranges: Array<[number, number]>,
	totalGeneratedLines: number,
): Array<[number, number]>;
export declare function mapGeneratedLineToOriginal(
	index: { reverse: Array<[number, number]>; tracer?: object },
	generatedLine: number,
	generatedColumn?: number,
): number | null;
export declare function countLines(content: string): number;
