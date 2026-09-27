#!/usr/bin/env node
/**
 * scripts/detect-untriaged-issues.mjs (#3563): fails a daily scheduled job
 * (`.github/workflows/untriaged-issues.yml`) when any open issue carries no
 * TYPE label or no `priority:*` label -- the mechanical check the 2026-09-26
 * incident asked for, since filing issues through the GitHub API bypasses
 * the issue templates that would otherwise force those labels.
 *
 * All logic lives in `scripts/lib/label-triage.mjs`; this file is a thin CLI
 * shell with no exports a test needs, so its unconditional `main()` call
 * below never fires under `vitest` (mirrors `detect-stale-open-issues.mjs`'s
 * own split from `scripts/lib/stale-open-issues.mjs`).
 */
import { appendFileSync } from "node:fs";
import {
	fetchOpenIssues,
	findUntriagedIssues,
	formatUntriagedReport,
} from "./lib/label-triage.mjs";

async function main() {
	const repository = process.env.GITHUB_REPOSITORY;
	const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
	if (!repository || !token)
		throw new Error("GITHUB_REPOSITORY and GH_TOKEN/GITHUB_TOKEN are required");
	const issues = await fetchOpenIssues(repository, token);
	const untriaged = findUntriagedIssues(issues);
	const report = formatUntriagedReport(untriaged);
	console.log(report);
	if (process.env.GITHUB_STEP_SUMMARY)
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
	if (untriaged.length > 0) {
		console.error(
			`::error::${untriaged.length} open issue(s) carry no TYPE label or no priority:* label`,
		);
		process.exitCode = 1;
	}
}

await main();
