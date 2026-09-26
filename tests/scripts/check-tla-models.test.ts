import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import {
	TLA_TOOLS,
	buildJavaArgs,
	classifyTlcOutput,
	computeConcurrency,
	computeSharedWorkers,
	computeWorkers,
	listModelConfigs,
	parseModelHeader,
	resolveJarPath,
	runPool,
	verdictMatches,
} from "../../scripts/check-tla-models.mjs";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

/** A promise plus its own resolve, for driving `runPool` step by step. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** Flush a couple of microtask turns so a resolved promise's `.then` chain runs. */
async function flushMicrotasks() {
	await Promise.resolve();
	await Promise.resolve();
}

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

// Trimmed from real TLC 2.19 runs of formal/file-locks.
const TLC_PASS = `TLC2 Version 2.19 of 08 August 2024 (rev: 5a47802)
Computing initial states...
Model checking completed. No error has been found.
178 states generated, 74 distinct states found, 0 states left on queue.`;
const TLC_VIOLATED = `TLC2 Version 2.19 of 08 August 2024 (rev: 5a47802)
Error: Invariant MutualExclusion is violated.
Error: The behavior up to this point is:
State 1: <Initial predicate>`;
const TLC_PARSE_ERROR = `TLC2 Version 2.19 of 08 August 2024 (rev: 5a47802)
Error: TLC threw an unexpected exception.
This was probably caused by an error in the spec or model.`;

describe("parseModelHeader (#3447)", () => {
	it("reads a pass expectation and its module", () => {
		expect(
			parseModelHeader("\\* expect: pass\n\\* module: FileLock\nCONSTANTS\n"),
		).toEqual({ module: "FileLock", expect: { status: "pass" } });
	});

	it("reads the invariant a violation expects", () => {
		expect(
			parseModelHeader(
				"\\* expect: violated NoOrphanLock\n\\* module: FileLock\n",
			),
		).toEqual({
			module: "FileLock",
			expect: { status: "violated", invariant: "NoOrphanLock" },
		});
	});

	it.each([
		[
			"no expectation",
			"\\* module: FileLock\n",
			"missing `\\* expect:` header",
		],
		["no module", "\\* expect: pass\n", "missing `\\* module:` header"],
		[
			"a violation with no invariant",
			"\\* expect: violated\n\\* module: FileLock\n",
			'unrecognised expectation "violated"',
		],
		[
			"an unknown verdict",
			"\\* expect: fails\n\\* module: FileLock\n",
			'unrecognised expectation "fails"',
		],
	])("names the header problem: %s", (_label, text, error) => {
		expect(parseModelHeader(text)).toEqual({ error });
	});
});

describe("classifyTlcOutput (#3447)", () => {
	it("reads a completed check as pass", () => {
		expect(classifyTlcOutput(TLC_PASS)).toEqual({ status: "pass" });
	});

	it("reads which invariant was violated", () => {
		expect(classifyTlcOutput(TLC_VIOLATED)).toEqual({
			status: "violated",
			invariant: "MutualExclusion",
		});
	});

	it("reports a spec or tool error rather than a verdict", () => {
		expect(classifyTlcOutput(TLC_PARSE_ERROR)).toEqual({
			status: "error",
			detail: "Error: TLC threw an unexpected exception.",
		});
		expect(classifyTlcOutput("")).toEqual({
			status: "error",
			detail: "no verdict",
		});
	});
});

describe("verdictMatches (#3447)", () => {
	const violated = (invariant: string) =>
		({ status: "violated", invariant }) as const;

	it("matches equal verdicts", () => {
		expect(verdictMatches({ status: "pass" }, { status: "pass" })).toBe(true);
		expect(
			verdictMatches(violated("MutualExclusion"), violated("MutualExclusion")),
		).toBe(true);
	});

	it("reds a fix the config does not record yet, and a hidden bug", () => {
		expect(
			verdictMatches(violated("MutualExclusion"), { status: "pass" }),
		).toBe(false);
		expect(
			verdictMatches({ status: "pass" }, violated("MutualExclusion")),
		).toBe(false);
	});

	it("reds a different invariant or a tool error", () => {
		expect(
			verdictMatches(violated("MutualExclusion"), violated("NoOrphanLock")),
		).toBe(false);
		expect(
			verdictMatches({ status: "pass" }, { status: "error", detail: "x" }),
		).toBe(false);
	});
});

describe("resolveJarPath (#3447)", () => {
	it("makes a relative --jar absolute, since TLC runs from each config's directory", () => {
		const resolved = resolveJarPath(".cache/tla2tools.jar", REPO_ROOT);
		expect(path.isAbsolute(resolved)).toBe(true);
		expect(resolved).toBe(path.resolve(".cache/tla2tools.jar"));
	});

	it("defaults to the repo's .cache/ jar", () => {
		expect(resolveJarPath(undefined, REPO_ROOT)).toBe(
			path.join(REPO_ROOT, ".cache", "tla2tools.jar"),
		);
	});
});

describe("computeConcurrency (#3572)", () => {
	it("bounds the pool by the CPU count when there are more configs than cores", () => {
		expect(computeConcurrency(320, 4)).toBe(4);
	});

	it("bounds the pool by the config count when there are fewer configs than cores", () => {
		expect(computeConcurrency(2, 8)).toBe(2);
	});

	it("floors at 1 even if the host reports zero or negative parallelism", () => {
		expect(computeConcurrency(320, 0)).toBe(1);
		expect(computeConcurrency(320, -1)).toBe(1);
	});
});

describe("computeSharedWorkers (#3572)", () => {
	it("divides the CPU budget evenly across the pool", () => {
		expect(computeSharedWorkers(8, 4)).toBe(2);
	});

	it("floors at 1 rather than giving a lane zero workers", () => {
		// A pool as wide as the CPU count (or wider, on a config-starved run)
		// must still give every lane a real worker to run TLC with.
		expect(computeSharedWorkers(4, 4)).toBe(1);
		expect(computeSharedWorkers(2, 5)).toBe(1);
	});
});

describe("computeWorkers (#3517)", () => {
	it("pins a violated-expectation config to one worker regardless of the pool's shared budget", () => {
		expect(computeWorkers({ status: "violated", invariant: "X" }, 4)).toBe(1);
		expect(computeWorkers({ status: "violated", invariant: "X" }, 1)).toBe(1);
	});

	it("gives a pass-expectation config the pool's shared worker budget", () => {
		expect(computeWorkers({ status: "pass" }, 4)).toBe(4);
		expect(computeWorkers({ status: "pass" }, 1)).toBe(1);
	});
});

describe("buildJavaArgs (#3572, #3517)", () => {
	it("passes the caller's worker count as a literal number, never `auto`", () => {
		const args = buildJavaArgs("/jar", "/meta", "X.cfg", "Mod", 1);
		const workersIndex = args.indexOf("-workers");
		expect(workersIndex).toBeGreaterThan(-1);
		expect(args[workersIndex + 1]).toBe("1");
	});

	it("runs the config by its basename, from the module's own directory", () => {
		const args = buildJavaArgs("/jar", "/meta", "X.cfg", "Mod", 3);
		expect(args).toEqual([
			"-Djava.io.tmpdir=/meta",
			"-XX:+UseParallelGC",
			"-cp",
			"/jar",
			"tlc2.TLC",
			"-workers",
			"3",
			"-metadir",
			"/meta",
			"-config",
			"X.cfg",
			"Mod",
		]);
	});

	it("pins the JVM temp dir to the run's own metadir, not the shared OS temp dir", () => {
		// SANY extracts the TLA+ standard modules to java.io.tmpdir under a
		// fixed filename, so two concurrent TLC processes sharing the OS temp
		// dir can race there (#3572: reproduced running the pool over all of
		// formal/, one `AbortException` in 320 configs). Each run must get its
		// own tmpdir instead of the JVM default.
		const args = buildJavaArgs("/jar", "/meta-a", "X.cfg", "Mod", 1);
		expect(args[0]).toBe("-Djava.io.tmpdir=/meta-a");
		const other = buildJavaArgs("/jar", "/meta-b", "X.cfg", "Mod", 1);
		expect(other[0]).toBe("-Djava.io.tmpdir=/meta-b");
	});
});

describe("runPool (#3572)", () => {
	it("never runs more tasks at once than the given concurrency", async () => {
		const items = [0, 1, 2, 3, 4];
		const controls = items.map(() => deferred<string>());
		const started: number[] = [];
		const task = vi.fn((item: number) => {
			started.push(item);
			return controls[item].promise;
		});

		const resultPromise = runPool(items, 2, task);

		// Two lanes claim their first item synchronously; the rest wait.
		expect(started).toEqual([0, 1]);

		controls[0].resolve("r0");
		await flushMicrotasks();
		expect(started).toEqual([0, 1, 2]);

		controls[1].resolve("r1");
		await flushMicrotasks();
		expect(started).toEqual([0, 1, 2, 3]);

		controls[2].resolve("r2");
		controls[3].resolve("r3");
		await flushMicrotasks();
		expect(started).toEqual([0, 1, 2, 3, 4]);

		controls[4].resolve("r4");
		expect(await resultPromise).toEqual(["r0", "r1", "r2", "r3", "r4"]);
	});

	it("returns results in input order even when later items finish first", async () => {
		const items = [0, 1, 2];
		const controls = items.map(() => deferred<string>());
		const task = (item: number) => controls[item].promise;

		const resultPromise = runPool(items, 3, task);
		// Complete item 2 first, then 0, then 1.
		controls[2].resolve("r2");
		controls[0].resolve("r0");
		controls[1].resolve("r1");

		expect(await resultPromise).toEqual(["r0", "r1", "r2"]);
	});

	it("does not silently drop every task when concurrency is zero", async () => {
		const task = vi.fn(async (item: number) => `r${item}`);
		const results = await runPool([0, 1, 2], 0, task);
		expect(task).toHaveBeenCalledTimes(3);
		expect(results).toEqual(["r0", "r1", "r2"]);
	});

	it("does not hang when concurrency exceeds the item count", async () => {
		const task = vi.fn(async (item: number) => `r${item}`);
		const results = await runPool([0, 1], 10, task);
		expect(results).toEqual(["r0", "r1"]);
	});
});

describe("formal/ models (#3447)", () => {
	const configs = listModelConfigs(REPO_ROOT);

	it("every config names its expectation and an existing module", () => {
		assertNonEmptyScan("TLA+ model configs", configs.length, 74);
		const problems = configs.flatMap((config) => {
			const header = parseModelHeader(fs.readFileSync(config, "utf8"));
			const name = path.relative(REPO_ROOT, config);
			if ("error" in header) return [`${name}: ${header.error}`];
			const spec = path.join(path.dirname(config), `${header.module}.tla`);
			return fs.existsSync(spec) ? [] : [`${name}: no ${header.module}.tla`];
		});
		expect(problems).toEqual([]);
	});

	it("CI runs the checker against the pinned tools release", () => {
		const workflow = yaml.load(
			fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8"),
		) as { jobs: Record<string, { steps?: Array<{ run?: string }> }> };
		const runs = Object.values(workflow.jobs).flatMap((job) =>
			(job.steps ?? []).map((step) => step.run ?? ""),
		);
		expect(
			runs.some((run) =>
				/^\s*node scripts\/check-tla-models\.mjs\s*$/m.test(run),
			),
		).toBe(true);
		expect(TLA_TOOLS.url).toContain(`/download/${TLA_TOOLS.release}/`);
	});
});
