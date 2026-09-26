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
 *   node scripts/mutation-pr-comment.mjs --pr <number> --stale \
 *     [--head-sha sha] [--run-url url]
 *
 * `--stale` (round 2 T6) marks the EXISTING sticky comment, if any, as
 * belonging to an earlier, different head: used when this head's job
 * produced no `reports/mutation/mutation.json` artifact to download at all
 * (a crash before `writeReport`, or the job hitting its own overall time
 * cap outright), so the comment job would otherwise have nothing to post
 * and an earlier head's now-irrelevant report would just stay up silently.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findStickyCommentId } from "./lib/mutation-pr-comment.mjs";
import {
	renderMutationMarkdown,
	renderStaleMarkdown,
	STICKY_MARKER,
} from "./lib/mutation-report-render.mjs";

function argumentValue(name, fallback) {
	let value = fallback;
	for (let index = 0; index < process.argv.length - 1; index += 1) {
		if (process.argv[index] === name) value = process.argv[index + 1];
	}
	return value;
}

const pr = argumentValue("--pr", null);
const stale = process.argv.includes("--stale");
const reportPath = argumentValue("--report", "reports/mutation/mutation.json");
const headSha = argumentValue("--head-sha", null);
const runUrl = argumentValue("--run-url", null);
if (!pr) {
	console.error("mutation-pr-comment: --pr <number> is required");
	process.exit(1);
}

const body = stale
	? renderStaleMarkdown({ headSha, runUrl })
	: renderMutationMarkdown(JSON.parse(readFileSync(reportPath, "utf8")));

function postOrUpdateStickyComment(commentBody) {
	const bodyFile = join(tmpdir(), `mutation-comment-${process.pid}.md`);
	writeFileSync(bodyFile, commentBody);
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
			if (stale) {
				// Nothing to mark stale: no prior sticky comment exists, so there
				// is nothing this PR's reader would mistake for current.
				console.log(
					`mutation-pr-comment: no existing sticky comment on PR #${pr} to mark stale; nothing to do`,
				);
				return;
			}
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
}

postOrUpdateStickyComment(body);
