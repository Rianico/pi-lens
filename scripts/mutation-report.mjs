#!/usr/bin/env node
/**
 * Renders reports/mutation/mutation.json (this repo's driver output, or any
 * Stryker JSON reporter output) as the same markdown the mutation workflow
 * posts as a job summary and a sticky PR comment (#3531). Usable standalone
 * by a fixer or reviewer to cite PR evidence:
 *
 *   node scripts/mutation-report.mjs [--report path] [--out path]
 *
 * Without `--out`, prints to stdout (so it composes with
 * `>> "$GITHUB_STEP_SUMMARY"` in CI, or a pager locally).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { renderMutationMarkdown } from "./lib/mutation-report-render.mjs";

function argumentValue(name, fallback) {
	let value = fallback;
	for (let index = 0; index < process.argv.length - 1; index += 1) {
		if (process.argv[index] === name) value = process.argv[index + 1];
	}
	return value;
}

const reportPath = argumentValue("--report", "reports/mutation/mutation.json");
const outPath = argumentValue("--out", null);

let report;
try {
	report = JSON.parse(readFileSync(reportPath, "utf8"));
} catch (error) {
	console.error(
		`mutation-report: could not read ${reportPath}: ${error.message}`,
	);
	process.exit(1);
}

const markdown = renderMutationMarkdown(report);
if (outPath) {
	writeFileSync(outPath, `${markdown}\n`);
} else {
	console.log(markdown);
}
