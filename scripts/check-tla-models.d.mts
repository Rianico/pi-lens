export type TlcVerdict =
	| { status: "pass" }
	| { status: "violated"; invariant: string }
	| { status: "error"; detail: string };
export type ExpectedVerdict =
	| { status: "pass" }
	| { status: "violated"; invariant: string };
export declare const TLA_TOOLS: Readonly<{
	release: string;
	url: string;
	sha256: string;
}>;
export declare function parseModelHeader(
	text: string,
): { module: string; expect: ExpectedVerdict } | { error: string };
export declare function classifyTlcOutput(output: string): TlcVerdict;
export declare function verdictMatches(
	expected: ExpectedVerdict,
	actual: TlcVerdict,
): boolean;
export declare function describeVerdict(verdict: TlcVerdict): string;
export declare function listModelConfigs(root: string): string[];
export declare function resolveJarPath(
	jarArg: string | undefined,
	root: string,
): string;
export declare function computeConcurrency(
	numConfigs: number,
	availableParallelism: number,
): number;
export declare function computeSharedWorkers(
	availableParallelism: number,
	concurrency: number,
): number;
export declare function computeWorkers(
	expect: ExpectedVerdict,
	sharedWorkers: number,
): number;
export declare function buildJavaArgs(
	jar: string,
	metadir: string,
	configBasename: string,
	module: string,
	workers: number,
): string[];
export declare function runPool<Item, Result>(
	items: readonly Item[],
	concurrency: number,
	task: (item: Item, index: number) => Promise<Result>,
): Promise<Result[]>;
