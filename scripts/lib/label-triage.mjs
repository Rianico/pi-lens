/**
 * scripts/lib/label-triage.mjs (#3563): the untriaged-issue predicate for the
 * daily "no type / no priority label" check.
 *
 * Incident: on 2026-09-26 the orchestrator filed about a dozen follow-up
 * issues (#3543-#3546, #3548, #3549, #3552, #3556, #3558, #3559, #3560)
 * through the GitHub API. Filing through the API bypasses the issue
 * templates, so nothing forced a TYPE or `priority:*` label, and they stayed
 * untriaged until the maintainer noticed by hand.
 *
 * TYPE_LABELS is DERIVED from `.github/labels.yml`'s own "# Type labels"
 * section rather than hand-copied (single-source-of-truth rule): that
 * manifest is the label set GitHub actually carries -- the syncer
 * (`.github/workflows/labels.yml`) runs with `prune: true` and DELETES any
 * live label absent from it (#2553) -- so it is the one place a TYPE label
 * can be added or removed without a second list silently drifting from it.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LABELS_MANIFEST_PATH = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../.github/labels.yml",
);

// A tracking issue is allowed a priority without a TYPE label (#3563's own
// Ask) -- this repo's convention for a work-queue issue like #3518.
const TRACKING_TITLE = /^\s*tracking:/i;

// This repo's own priority convention (`priority:p1`/`p2`/`p3`, see
// `.github/labels.yml`'s "Priority labels" block) -- a prefix match, like
// `scripts/lib/stale-open-issues.mjs`'s own `PRIORITY_LABEL`, so a future
// `priority:p4` needs no update here.
const PRIORITY_LABEL = /^priority:p\d+$/i;

function labelName(label) {
	return typeof label === "string" ? label : (label?.name ?? "");
}

/**
 * Every `- name: <x>` line between the "# Type labels" comment and the next
 * blank line in `.github/labels.yml`'s raw text. Throws rather than
 * returning an empty/wrong result on ANY shape it does not recognize (no
 * marker found, or zero names collected) -- a silent empty TYPE_LABELS would
 * make every open issue read as "has no type label", which is a false
 * positive on the entire population, not a safe default.
 */
export function deriveTypeLabels(
	manifestText = readFileSync(LABELS_MANIFEST_PATH, "utf8"),
) {
	const lines = manifestText.split("\n");
	const startIndex = lines.findIndex((line) => line.trim() === "# Type labels");
	if (startIndex === -1)
		throw new Error(
			'label-triage: ".github/labels.yml" has no "# Type labels" section -- did it get renamed or reworded?',
		);
	const names = [];
	for (let i = startIndex + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === "") break;
		const match = /^-\s*name:\s*(.+)$/.exec(line);
		if (match) names.push(match[1].trim().replace(/^["']|["']$/g, ""));
	}
	if (names.length === 0)
		throw new Error(
			'label-triage: derived zero TYPE labels from ".github/labels.yml"\'s "# Type labels" block -- did its "- name: x" format change?',
		);
	return names;
}

export const TYPE_LABELS = deriveTypeLabels();

/** True for a `tracking:` issue title (case-insensitive, leading whitespace
 * tolerated) -- the Ask's own exemption: allowed a priority without a
 * TYPE label. */
export function isTrackingIssueTitle(title) {
	return TRACKING_TITLE.test(String(title ?? ""));
}

export function hasTypeLabel(labels, typeLabels = TYPE_LABELS) {
	const typeSet = new Set(typeLabels.map((name) => name.toLowerCase()));
	return (Array.isArray(labels) ? labels : []).some((label) =>
		typeSet.has(labelName(label).toLowerCase()),
	);
}

export function hasPriorityLabel(labels) {
	return (Array.isArray(labels) ? labels : []).some((label) =>
		PRIORITY_LABEL.test(labelName(label)),
	);
}

/**
 * True when `issue` is untriaged per #3563: an open, non-pull-request issue
 * missing its `priority:*` label, or -- unless its title is a `tracking:`
 * issue, which is allowed a priority without a TYPE label -- missing its
 * TYPE label too. A pull request is never flagged: the GitHub issues-list
 * endpoint returns PRs too (each carrying a `pull_request` key), and this
 * check is about ISSUE triage, not PR labelling.
 */
export function isUntriagedIssue(issue, typeLabels = TYPE_LABELS) {
	if (issue?.pull_request) return false;
	const labels = Array.isArray(issue?.labels) ? issue.labels : [];
	const missingPriority = !hasPriorityLabel(labels);
	if (isTrackingIssueTitle(issue?.title)) return missingPriority;
	return missingPriority || !hasTypeLabel(labels, typeLabels);
}

/**
 * Every untriaged issue in `issues`, each paired with which label(s) it is
 * missing (`"type"`, `"priority"`, or both) -- named rather than just
 * filtered, so the report (and a reviewer reading it) can say WHY an issue
 * was flagged instead of just that it was.
 */
export function findUntriagedIssues(issues, typeLabels = TYPE_LABELS) {
	const result = [];
	for (const issue of Array.isArray(issues) ? issues : []) {
		if (!isUntriagedIssue(issue, typeLabels)) continue;
		const labels = Array.isArray(issue?.labels) ? issue.labels : [];
		const missing = [];
		if (
			!isTrackingIssueTitle(issue?.title) &&
			!hasTypeLabel(labels, typeLabels)
		)
			missing.push("type");
		if (!hasPriorityLabel(labels)) missing.push("priority");
		result.push({ issue, missing });
	}
	return result;
}

export const MAX_PAGES = 5;
export const PAGE_SIZE = 100;

/** Every open issue (and PR -- filtered out by `isUntriagedIssue` itself, not
 * here, so a caller inspecting the raw list still sees PRs if it wants to).
 * Fails closed on a truncated final page (#1356-style: no silent partial
 * data) rather than reporting "no candidates" over an incomplete read. Lives
 * here, not in the CLI script, so a test can import it without triggering
 * the CLI's own top-level `main()` (`scripts/detect-stale-open-issues.mjs`'s
 * own split from `scripts/lib/stale-open-issues.mjs` is the precedent). */
export async function fetchOpenIssues(repository, token, fetchImpl = fetch) {
	const issues = [];
	for (let page = 1; page <= MAX_PAGES; page++) {
		const response = await fetchImpl(
			`https://api.github.com/repos/${repository}/issues?state=open&per_page=${PAGE_SIZE}&page=${page}`,
			{
				headers: {
					Accept: "application/vnd.github+json",
					Authorization: `Bearer ${token}`,
					"X-GitHub-Api-Version": "2022-11-28",
				},
			},
		);
		if (!response.ok)
			throw new Error(
				`GitHub API returned ${response.status} listing open issues (page ${page})`,
			);
		const batch = await response.json();
		if (!Array.isArray(batch))
			throw new Error("GitHub API returned a non-array open-issue list");
		issues.push(...batch);
		if (batch.length < PAGE_SIZE) return issues;
	}
	throw new Error(
		`GitHub API pagination bound (${MAX_PAGES} pages) reached listing open issues; refusing to use a partial list`,
	);
}

function formatIssueLine({ issue, missing }) {
	const link = issue.html_url
		? `[#${issue.number}](${issue.html_url})`
		: `#${issue.number}`;
	return `- ${link} **${issue.title}** — missing: ${missing.join(", ")}`;
}

export function formatUntriagedReport(untriaged) {
	const lines = ["## Untriaged open issues (#3563)", ""];
	if (untriaged.length === 0) {
		lines.push(
			"None. Every open issue carries a TYPE label (or is a `tracking:` issue) and a `priority:*` label.",
		);
		return lines.join("\n");
	}
	lines.push(
		`${untriaged.length} open issue(s) are missing a required label:`,
		"",
	);
	for (const entry of untriaged) lines.push(formatIssueLine(entry));
	return lines.join("\n");
}
