#!/usr/bin/env node
/**
 * Model-check every TLA+ config under formal/ and compare TLC's verdict with
 * the one the config expects (#3447).
 *
 * Each `.cfg` starts with two header lines:
 *
 *   \* expect: pass                        (or: violated <InvariantName>)
 *   \* module: FileLock                    (the .tla beside it)
 *
 * A config that documents a known bug expects the violation, so the check is
 * a ratchet both ways: a model edit that hides the bug reds, and a fix that
 * makes the invariant hold reds until its config says `pass`.
 *
 * Configs run through a bounded-concurrency pool (#3572) sized to the host's
 * CPU count, so the job's wall time falls well below the sum of every
 * config's own time. A config that documents a `violated` expectation always
 * runs with a single TLC worker (#3517): TLC's `-workers auto` explores the
 * state graph across several threads, so when a model can violate more than
 * one invariant, whichever thread gets there first decides which one TLC
 * reports — a race the pool would otherwise make worse, not better, by
 * adding CPU contention. One worker gives deterministic BFS order and so a
 * deterministic first violation, at no verdict cost: a `pass` config has
 * nothing to race on (every worker must finish exploring the same state
 * graph to report "no error found"), so it keeps a shared multi-worker
 * budget for throughput.
 *
 * Usage: node scripts/check-tla-models.mjs [--jar <tla2tools.jar>] [--concurrency <n>]
 * Without --jar, the pinned release is downloaded to .cache/ and verified.
 * Without --concurrency, the pool is sized to the host's CPU count.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TLA_TOOLS = Object.freeze({
	release: "v1.7.4",
	url: "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar",
	sha256: "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88",
});

const EXPECT_LINE = /^\\\*\s*expect:\s*(.+?)\s*$/m;
const MODULE_LINE = /^\\\*\s*module:\s*([A-Za-z_]\w*)\s*$/m;

/**
 * Read a config's expected verdict and module. Returns `{ error }` for a
 * missing or malformed header, so the check can name the file.
 */
export function parseModelHeader(text) {
	const expectMatch = EXPECT_LINE.exec(text);
	const moduleMatch = MODULE_LINE.exec(text);
	if (!expectMatch) return { error: "missing `\\* expect:` header" };
	if (!moduleMatch) return { error: "missing `\\* module:` header" };
	const value = expectMatch[1];
	if (value === "pass")
		return { module: moduleMatch[1], expect: { status: "pass" } };
	const violated = /^violated\s+([A-Za-z_]\w*)$/.exec(value);
	if (violated)
		return {
			module: moduleMatch[1],
			expect: { status: "violated", invariant: violated[1] },
		};
	return { error: `unrecognised expectation "${value}"` };
}

/** TLC's verdict from its combined output. */
export function classifyTlcOutput(output) {
	const violated = /Error: Invariant (\w+) is violated/.exec(output);
	if (violated) return { status: "violated", invariant: violated[1] };
	if (/Model checking completed\. No error has been found\./.test(output))
		return { status: "pass" };
	const errorLine = output
		.split("\n")
		.find((line) => /Error|Exception/.test(line));
	return { status: "error", detail: errorLine?.trim() ?? "no verdict" };
}

export function verdictMatches(expected, actual) {
	if (expected.status !== actual.status) return false;
	return (
		expected.status !== "violated" || expected.invariant === actual.invariant
	);
}

export function describeVerdict(verdict) {
	if (verdict.status === "violated") return `violated ${verdict.invariant}`;
	if (verdict.status === "error") return `error: ${verdict.detail}`;
	return "pass";
}

/** Every `formal/<dir>/*.cfg`, sorted. */
export function listModelConfigs(root) {
	const formal = path.join(root, "formal");
	if (!fs.existsSync(formal)) return [];
	const configs = [];
	for (const dir of fs.readdirSync(formal, { withFileTypes: true })) {
		if (!dir.isDirectory()) continue;
		const abs = path.join(formal, dir.name);
		for (const file of fs.readdirSync(abs)) {
			if (file.endsWith(".cfg")) configs.push(path.join(abs, file));
		}
	}
	return configs.sort();
}

/**
 * The jar TLC runs from, as an absolute path: TLC runs with each config's
 * directory as cwd, so a relative `--jar` would not resolve there.
 */
export function resolveJarPath(jarArg, root) {
	return path.resolve(jarArg ?? path.join(root, ".cache", "tla2tools.jar"));
}

function sha256(file) {
	return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function ensureJar(jarArg, root) {
	const jar = resolveJarPath(jarArg, root);
	if (!fs.existsSync(jar)) {
		if (jarArg) throw new Error(`--jar ${jarArg} does not exist`);
		fs.mkdirSync(path.dirname(jar), { recursive: true });
		const response = await fetch(TLA_TOOLS.url);
		if (!response.ok)
			throw new Error(`download ${TLA_TOOLS.url}: HTTP ${response.status}`);
		fs.writeFileSync(jar, Buffer.from(await response.arrayBuffer()));
	}
	const actual = sha256(jar);
	if (actual !== TLA_TOOLS.sha256)
		throw new Error(
			`${jar}: sha256 ${actual}, expected ${TLA_TOOLS.sha256} (${TLA_TOOLS.release})`,
		);
	return jar;
}

/**
 * How many configs run at once. Bounded by the host's CPU count (more lanes
 * than cores only adds scheduling overhead) and by the config count itself
 * (never more lanes than there is work).
 */
export function computeConcurrency(numConfigs, availableParallelism) {
	return Math.max(1, Math.min(numConfigs, availableParallelism));
}

/**
 * TLC workers per run for a `pass`-expectation config, sharing the host's
 * CPUs evenly across the concurrent pool. Floored at 1: a pool as wide as
 * the CPU count still gives every lane a real worker, not a fraction of one.
 */
export function computeSharedWorkers(availableParallelism, concurrency) {
	return Math.max(1, Math.floor(availableParallelism / concurrency));
}

/**
 * The `-workers` count for one config (#3517). A `violated` expectation is
 * pinned to 1 for deterministic BFS order regardless of the shared pool
 * budget; a `pass` expectation has no race to guard against, so it uses the
 * pool's shared per-lane count.
 */
export function computeWorkers(expect, sharedWorkers) {
	return expect.status === "violated" ? 1 : sharedWorkers;
}

/** The `java` argv TLC runs with, as a pure function so tests need no JVM. */
export function buildJavaArgs(jar, metadir, configBasename, module, workers) {
	return [
		"-XX:+UseParallelGC",
		"-cp",
		jar,
		"tlc2.TLC",
		"-workers",
		String(workers),
		"-metadir",
		metadir,
		"-config",
		configBasename,
		module,
	];
}

function runTlc(jar, config, module, workers) {
	const metadir = fs.mkdtempSync(path.join(os.tmpdir(), "tlc-"));
	const args = buildJavaArgs(
		jar,
		metadir,
		path.basename(config),
		module,
		workers,
	);
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn("java", args, { cwd: path.dirname(config) });
		} catch (error) {
			fs.rmSync(metadir, { recursive: true, force: true });
			resolve({ status: "error", detail: error.message });
			return;
		}
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			fs.rmSync(metadir, { recursive: true, force: true });
			resolve({ status: "error", detail: error.message });
		});
		child.on("close", () => {
			fs.rmSync(metadir, { recursive: true, force: true });
			resolve(classifyTlcOutput(`${stdout}\n${stderr}`));
		});
	});
}

/**
 * Runs `task` over `items` with at most `concurrency` in flight at once,
 * returning results in input order regardless of completion order. Plain
 * async, no timers or real processes of its own, so it is unit-testable
 * with synthetic tasks (`tests/scripts/check-tla-models.test.ts`).
 */
export async function runPool(items, concurrency, task) {
	const results = Array.from({ length: items.length });
	let next = 0;
	async function lane() {
		for (;;) {
			const i = next;
			next += 1;
			if (i >= items.length) return;
			results[i] = await task(items[i], i);
		}
	}
	const lanes = Array.from(
		{ length: Math.min(concurrency, items.length) || 1 },
		lane,
	);
	await Promise.all(lanes);
	return results;
}

async function main() {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const argv = process.argv;
	const jarIndex = argv.indexOf("--jar");
	const jar = await ensureJar(
		jarIndex === -1 ? undefined : argv[jarIndex + 1],
		root,
	);
	const concurrencyIndex = argv.indexOf("--concurrency");
	const configs = listModelConfigs(root);
	if (configs.length === 0) throw new Error("no formal/*/*.cfg found");

	const availableParallelism =
		typeof os.availableParallelism === "function"
			? os.availableParallelism()
			: os.cpus().length;
	const concurrency =
		concurrencyIndex === -1
			? computeConcurrency(configs.length, availableParallelism)
			: Math.max(1, Number(argv[concurrencyIndex + 1]));
	const sharedWorkers = computeSharedWorkers(availableParallelism, concurrency);

	const wallStarted = Date.now();
	const outcomes = await runPool(configs, concurrency, async (config) => {
		const name = path.relative(root, config);
		const header = parseModelHeader(fs.readFileSync(config, "utf8"));
		if (header.error) {
			console.log(`FAIL ${name}: ${header.error}`);
			return { name, dir: path.dirname(name), ok: false, seconds: 0 };
		}
		const workers = computeWorkers(header.expect, sharedWorkers);
		const started = Date.now();
		const actual = await runTlc(jar, config, header.module, workers);
		const seconds = (Date.now() - started) / 1000;
		const ok = verdictMatches(header.expect, actual);
		console.log(
			`${ok ? "ok  " : "FAIL"} ${name}: expected ${describeVerdict(header.expect)}, got ${describeVerdict(actual)} (${seconds.toFixed(1)}s, workers=${workers})`,
		);
		return { name, dir: path.dirname(name), ok, seconds };
	});
	const wallSeconds = (Date.now() - wallStarted) / 1000;

	const failures = outcomes.filter((outcome) => !outcome.ok).length;
	const perDir = new Map();
	for (const outcome of outcomes) {
		const totals = perDir.get(outcome.dir) ?? { seconds: 0, count: 0 };
		totals.seconds += outcome.seconds;
		totals.count += 1;
		perDir.set(outcome.dir, totals);
	}
	const dirLines = [...perDir.entries()]
		.sort((a, b) => b[1].seconds - a[1].seconds)
		.map(
			([dir, totals]) =>
				`  ${dir}: ${totals.seconds.toFixed(1)}s summed over ${totals.count} configs`,
		);
	console.log("");
	console.log(
		`${configs.length} configs, ${wallSeconds.toFixed(1)}s wall (concurrency=${concurrency}, ${sharedWorkers} worker(s)/pass-config, 1 worker/violated-config).`,
	);
	console.log("Per-directory TLC time (summed, not wall time):");
	for (const line of dirLines) console.log(line);

	if (failures > 0) {
		console.log(`${failures} of ${configs.length} models did not match.`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
