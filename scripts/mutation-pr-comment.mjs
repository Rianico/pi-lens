#!/usr/bin/env node
/**
 * Posts (or updates in place) the sticky mutation-diff PR comment (#3531).
 * Requires `gh` on PATH with a write-scoped token (`GH_TOKEN`) and
 * `GH_REPO` (both set by the workflow's comment job) plus `--pr <number>`.
 *
 * Never call this from a fork PR's job: GitHub gives a fork PR's default
 * token read-only access to the base repo regardless of the workflow's
 * declared `permissions:`, so the `gh api` POST/PATCH below would fail --
 * the workflow guards this step with `if:` on same-repo before running it,
 * per #3531's "mind fork PRs" requirement; this script does not re-check
 * that itself, since it has no reliable way to tell a same-repo PR from a
 * fork one without the event payload the workflow already has.
 *
 *   node scripts/mutation-pr-comment.mjs --pr <number> [--report path]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	renderMutationMarkdown,
	STICKY_MARKER,
} from "./lib/mutation-report-render.mjs";
import { findStickyCommentId } from "./lib/mutation-pr-comment.mjs";

function argumentValue(name, fallback) {
	let value = fallback;
	for (let index = 0; index < process.argv.length - 1; index += 1) {
		if (process.argv[index] === name) value = process.argv[index + 1];
	}
	return value;
}

const pr = argumentValue("--pr", null);
const reportPath = argumentValue("--report", "reports/mutation/mutation.json");
if (!pr) {
	console.error("mutation-pr-comment: --pr <number> is required");
	process.exit(1);
}

const report = JSON.parse(readFileSync(reportPath, "utf8"));
const body = renderMutationMarkdown(report);

const bodyFile = join(tmpdir(), `mutation-comment-${process.pid}.md`);
writeFileSync(bodyFile, body);

try {
	const comments = JSON.parse(
		execFileSync(
			"gh",
			["api", `repos/{owner}/{repo}/issues/${pr}/comments`, "--paginate"],
			{ encoding: "utf8" },
		),
	);
	const stickyId = findStickyCommentId(comments, STICKY_MARKER);

	if (stickyId) {
		execFileSync("gh", [
			"api",
			"-X",
			"PATCH",
			`repos/{owner}/{repo}/issues/comments/${stickyId}`,
			"-F",
			`body=@${bodyFile}`,
		]);
		console.log(
			`mutation-pr-comment: updated comment ${stickyId} on PR #${pr}`,
		);
	} else {
		execFileSync("gh", [
			"api",
			"-X",
			"POST",
			`repos/{owner}/{repo}/issues/${pr}/comments`,
			"-F",
			`body=@${bodyFile}`,
		]);
		console.log(
			`mutation-pr-comment: posted a new sticky comment on PR #${pr}`,
		);
	}
} finally {
	unlinkSync(bodyFile);
}
