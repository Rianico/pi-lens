/**
 * #3555: a read pi-lens widened to its enclosing symbol or Markdown section
 * says so in the result, and the widening follows the read guard's switch.
 *
 * Through the real `handleToolCall` / `handleToolResult` / `RuntimeCoordinator`
 * and pi's real `read` tool. The tree-sitter client is the same stub shape
 * `read-expansion.test.ts` uses (a fixed tree); the Markdown fast path needs no
 * parser at all.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { resolvePiLensFlag } from "../../clients/lens-config.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolCall } from "../../clients/runtime-tool-call.js";
import { handleToolResult } from "../../clients/runtime-tool-result.js";
import { setupTestEnvironment } from "./test-utils.js";

vi.mock("../../clients/lsp/index.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/lsp/index.js")>()),
	getLSPService: vi.fn(),
}));

import { getLSPService } from "../../clients/lsp/index.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

type Content = Array<{ type: string; text?: string }>;

const guardOn = (name: string) => name === "no-complexity";
const guardOff = (name: string) =>
	name === "no-complexity" || name === "no-read-guard";

/** A function_declaration spanning `startRow..endRow` (0-based), named `name`. */
function stubTreeSitter(startRow: number, endRow: number, name: string) {
	const fn = {
		type: "function_declaration",
		text: name,
		startPosition: { row: startRow, column: 0 },
		endPosition: { row: endRow, column: 0 },
		children: [
			{
				type: "identifier",
				text: name,
				children: [],
				startPosition: { row: startRow, column: 0 },
				endPosition: { row: startRow, column: 0 },
				parent: null as unknown,
			},
		],
		parent: null as unknown,
	};
	fn.children[0].parent = fn;
	const tree = {
		rootNode: {
			type: "program",
			text: "",
			startPosition: { row: 0, column: 0 },
			endPosition: { row: endRow + 10, column: 0 },
			children: [fn],
			parent: null,
		},
	};
	fn.parent = tree.rootNode;
	return {
		init: async () => true,
		withParsedTree: async (
			_file: string,
			_lang: string,
			_content: string | undefined,
			consume: (tree: unknown) => unknown,
		) => ({ parsed: true as const, value: consume(tree) }),
	};
}

let seq = 0;

/**
 * pi's read with pi-lens around it: tool_call (which may widen `input` in
 * place), pi's real read tool on the input as executed, tool_result.
 */
async function piRead(
	runtime: RuntimeCoordinator,
	input: { path: string; offset?: number; limit?: number },
	opts: {
		getFlag?: (name: string) => boolean;
		treeSitter?: ReturnType<typeof stubTreeSitter>;
		toolCallId?: string | null;
		isError?: boolean;
	} = {},
) {
	const toolCallId =
		opts.toolCallId === null ? undefined : (opts.toolCallId ?? `read-${++seq}`);
	const getFlag = opts.getFlag ?? guardOn;
	await handleToolCall({
		event: { toolName: "read", toolCallId, input },
		ctx: { cwd: runtime.projectRoot },
		lensEnabled: true,
		getFlag,
		dbg: () => {},
		runtime,
		cacheManager: new CacheManager(false),
		ensureLSPConfigInitialized: async () => {},
		updateLspStatus: () => {},
		resetLSPService: () => {},
		...(opts.treeSitter ? { getTreeSitterClient: () => opts.treeSitter } : {}),
	} as never);
	const tool = createReadToolDefinition(runtime.projectRoot);
	const executed = await tool.execute(
		toolCallId ?? "no-id",
		input,
		undefined,
		undefined,
		{ cwd: runtime.projectRoot } as never,
	);
	const result = (await handleToolResult({
		event: {
			toolName: "read",
			toolCallId,
			input,
			content: executed.content,
			details: executed.details,
			...(opts.isError ? { isError: true } : {}),
		},
		getFlag,
		dbg: () => {},
		runtime,
		cacheManager: new CacheManager(false),
		resetLSPService: () => {},
		readGuard: runtime.readGuard,
		agentBehaviorRecord: () => [],
		formatBehaviorWarnings: () => "",
	} as never)) as { content: Content } | undefined;
	return {
		input,
		host: executed.content as Content,
		content: result?.content ?? (executed.content as Content),
	};
}

const NOTE = /^\[pi-lens: read widened/;

function newRuntime(dir: string): RuntimeCoordinator {
	const runtime = new RuntimeCoordinator();
	runtime.projectRoot = dir;
	return runtime;
}

const lines = (n: number, prefix = "line") =>
	Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

beforeEach(() => {
	vi.mocked(getLSPService).mockReturnValue(
		makeLspServiceDouble({
			supportsLSP: () => false,
			hasLSP: async () => false,
			openFile: async () => {},
			touchFile: async () => {},
		}) as never,
	);
});

describe("#3555: a widened read is labelled", () => {
	it("leads a symbol-widened read with a note naming both ranges, then the host text verbatim", async () => {
		const env = setupTestEnvironment("rw-3555-symbol-");
		try {
			const file = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(file, lines(40).join("\n"));
			const runtime = newRuntime(env.tmpDir);
			const read = await piRead(
				runtime,
				{ path: file, offset: 12, limit: 3 },
				{ treeSitter: stubTreeSitter(9, 19, "handler") },
			);
			expect([read.input.offset, read.input.limit]).toEqual([10, 11]);
			expect(read.content[0]).toEqual({
				type: "text",
				text: '[pi-lens: read widened to the enclosing function_declaration "handler" (symbol boundary): you asked for lines 12-14, this shows lines 10-20. Re-request with limit > 100 for the exact range.]',
			});
			expect(read.content.slice(1)).toEqual(read.host);
		} finally {
			env.cleanup();
		}
	});

	it("names the heading of a Markdown section it widened to", async () => {
		const env = setupTestEnvironment("rw-3555-md-");
		try {
			const file = path.join(env.tmpDir, "notes.md");
			fs.writeFileSync(
				file,
				[
					"# Title",
					...lines(9, "intro"),
					"## Tareas",
					...lines(30, "task"),
					"## Veredicto",
					...lines(5, "end"),
				].join("\n"),
			);
			const runtime = newRuntime(env.tmpDir);
			const read = await piRead(runtime, { path: file, offset: 20, limit: 5 });
			expect([read.input.offset, read.input.limit]).toEqual([11, 31]);
			expect(read.content[0]?.text).toBe(
				'[pi-lens: read widened to the Markdown section under the heading "Tareas" (heading boundary): you asked for lines 20-24, this shows lines 11-41. Re-request with limit > 100 for the exact range.]',
			);
			expect(read.content.slice(1)).toEqual(read.host);
		} finally {
			env.cleanup();
		}
	});

	it("labels a widened read the agent named by a relative path", async () => {
		const env = setupTestEnvironment("rw-3555-relative-");
		try {
			fs.writeFileSync(
				path.join(env.tmpDir, "notes.md"),
				["## Tareas", ...lines(30)].join("\n"),
			);
			const runtime = newRuntime(env.tmpDir);
			const read = await piRead(runtime, {
				path: "notes.md",
				offset: 10,
				limit: 2,
			});
			expect([read.input.offset, read.input.limit]).toEqual([1, 31]);
			expect(read.content[0]?.text).toMatch(NOTE);
			expect(read.content.slice(1)).toEqual(read.host);
		} finally {
			env.cleanup();
		}
	});

	it("keeps pi's own truncation notice after the text when the widened range is truncated", async () => {
		const env = setupTestEnvironment("rw-3555-truncated-");
		try {
			const file = path.join(env.tmpDir, "big.md");
			const long = "x".repeat(400);
			fs.writeFileSync(
				file,
				["## Big", ...lines(200, `${long} `), "## Next", "tail"].join("\n"),
			);
			const runtime = newRuntime(env.tmpDir);
			const read = await piRead(runtime, { path: file, offset: 50, limit: 5 });
			expect(read.content[0]?.text).toMatch(NOTE);
			const host = read.content
				.slice(1)
				.map((part) => part.text)
				.join("\n");
			expect(host).toMatch(/\[Showing lines 1-\d+ of 203 \(50\.0KB limit\)/);
			expect(read.content.slice(1)).toEqual(read.host);
		} finally {
			env.cleanup();
		}
	});
});

describe("#3555: an unwidened read carries no note", () => {
	it("adds nothing to a read above the expansion limit", async () => {
		const env = setupTestEnvironment("rw-3555-large-");
		try {
			const file = path.join(env.tmpDir, "notes.md");
			fs.writeFileSync(file, ["## A", ...lines(300)].join("\n"));
			const runtime = newRuntime(env.tmpDir);
			const read = await piRead(runtime, {
				path: file,
				offset: 140,
				limit: 101,
			});
			expect([read.input.offset, read.input.limit]).toEqual([140, 101]);
			expect(read.content).toEqual(read.host);
		} finally {
			env.cleanup();
		}
	});

	it("adds nothing to a read of a file the expansion does not understand", async () => {
		const env = setupTestEnvironment("rw-3555-plain-");
		try {
			const file = path.join(env.tmpDir, "notes.txt");
			fs.writeFileSync(file, lines(40).join("\n"));
			const runtime = newRuntime(env.tmpDir);
			const read = await piRead(
				runtime,
				{ path: file, offset: 12, limit: 3 },
				{ treeSitter: stubTreeSitter(9, 19, "handler") },
			);
			expect([read.input.offset, read.input.limit]).toEqual([12, 3]);
			expect(read.content).toEqual(read.host);
		} finally {
			env.cleanup();
		}
	});

	it("does not carry a widening over to a later read or repeat it", async () => {
		const env = setupTestEnvironment("rw-3555-stale-");
		try {
			const md = path.join(env.tmpDir, "notes.md");
			fs.writeFileSync(md, ["## Tareas", ...lines(30)].join("\n"));
			// Not expandable, so its own read is never widened.
			const other = path.join(env.tmpDir, "other.txt");
			fs.writeFileSync(other, lines(30).join("\n"));
			const runtime = newRuntime(env.tmpDir);
			const widened = await piRead(runtime, { path: md, offset: 10, limit: 2 });
			expect(widened.content[0]?.text).toMatch(NOTE);
			const later = await piRead(runtime, {
				path: other,
				offset: 10,
				limit: 2,
			});
			expect(later.content).toEqual(later.host);
			// The same call id's result, delivered twice, is labelled once.
			const again = (await handleToolResult({
				event: {
					toolName: "read",
					toolCallId: `read-${seq - 1}`,
					input: widened.input,
					content: widened.host,
				},
				getFlag: guardOn,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				resetLSPService: () => {},
				readGuard: runtime.readGuard,
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as never)) as { content: Content } | undefined;
			expect(again?.content ?? widened.host).toEqual(widened.host);
		} finally {
			env.cleanup();
		}
	});

	it("labels no failed read", async () => {
		const env = setupTestEnvironment("rw-3555-error-");
		try {
			const md = path.join(env.tmpDir, "notes.md");
			fs.writeFileSync(md, ["## Tareas", ...lines(30)].join("\n"));
			const runtime = newRuntime(env.tmpDir);
			const read = await piRead(
				runtime,
				{ path: md, offset: 10, limit: 2 },
				{ isError: true },
			);
			expect([read.input.offset, read.input.limit]).toEqual([1, 31]);
			expect(read.content).toEqual(read.host);
		} finally {
			env.cleanup();
		}
	});
});

describe("#3555: the widening follows the read guard's switch", () => {
	it("reads exactly the requested range under --no-read-guard", async () => {
		const env = setupTestEnvironment("rw-3555-flag-off-");
		try {
			const file = path.join(env.tmpDir, "notes.md");
			fs.writeFileSync(file, ["## Tareas", ...lines(30)].join("\n"));
			const runtime = newRuntime(env.tmpDir);
			const read = await piRead(
				runtime,
				{ path: file, offset: 10, limit: 2 },
				{ getFlag: guardOff },
			);
			expect([read.input.offset, read.input.limit]).toEqual([10, 2]);
			expect(read.content).toEqual(read.host);
		} finally {
			env.cleanup();
		}
	});

	it("reads exactly the requested range with readGuard.enabled=false in the global config", async () => {
		const env = setupTestEnvironment("rw-3555-config-off-");
		try {
			const file = path.join(env.tmpDir, "notes.md");
			fs.writeFileSync(file, ["## Tareas", ...lines(30)].join("\n"));
			const runtime = newRuntime(env.tmpDir);
			// The registry's own resolution of a config with no CLI flag set.
			const fromConfig = (name: string) =>
				name === "no-complexity" ||
				resolvePiLensFlag(name, undefined, {
					readGuard: { enabled: false },
				} as never) === true;
			expect(fromConfig("no-read-guard")).toBe(true);
			const read = await piRead(
				runtime,
				{ path: file, offset: 10, limit: 2 },
				{ getFlag: fromConfig },
			);
			expect([read.input.offset, read.input.limit]).toEqual([10, 2]);
		} finally {
			env.cleanup();
		}
	});

	it("still widens with the read guard on", async () => {
		const env = setupTestEnvironment("rw-3555-flag-on-");
		try {
			const file = path.join(env.tmpDir, "notes.md");
			fs.writeFileSync(file, ["## Tareas", ...lines(30)].join("\n"));
			const runtime = newRuntime(env.tmpDir);
			const read = await piRead(runtime, { path: file, offset: 10, limit: 2 });
			expect([read.input.offset, read.input.limit]).toEqual([1, 31]);
			expect(read.content[0]?.text).toMatch(NOTE);
		} finally {
			env.cleanup();
		}
	});
});
