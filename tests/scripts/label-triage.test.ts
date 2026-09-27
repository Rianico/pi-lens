import { describe, expect, it } from "vitest";
import {
	deriveTypeLabels,
	findUntriagedIssues,
	formatUntriagedReport,
	hasPriorityLabel,
	hasTypeLabel,
	isTrackingIssueTitle,
	isUntriagedIssue,
	TYPE_LABELS,
} from "../../scripts/lib/label-triage.mjs";

/**
 * #3563: on 2026-09-26 the orchestrator filed about a dozen follow-up issues
 * through the GitHub API (#3543-#3546, #3548, #3549, #3552, #3556, #3558,
 * #3559, #3560) with no TYPE label and no priority:* label -- filing through
 * the API bypasses the issue templates that would otherwise force one.
 *
 * Red-first proof: `findUntriagedIssues` did not exist before this change --
 * any caller of it (or the CLI script) throws a bare "is not a function" on
 * the pre-fix tree. The fixture below is shaped exactly like the incident:
 * one issue carrying neither label (#3543's own shape at filing time), one
 * carrying both (this same PR's own #3563), and one `tracking:`-titled issue
 * (#3518's own shape) that is allowed a priority without a TYPE label.
 */

function issue({
	number,
	title,
	labels = [],
	pull_request = undefined,
}: {
	number: number;
	title: string;
	labels?: string[];
	pull_request?: object;
}) {
	return {
		number,
		title,
		labels,
		pull_request,
		html_url: `https://github.com/apmantza/pi-lens/issues/${number}`,
	};
}

describe("deriveTypeLabels (#3563)", () => {
	it("derives every name from the '# Type labels' block", () => {
		expect(
			deriveTypeLabels(
				[
					"# Type labels",
					"- name: bug",
					"  color: d73a4a",
					"- name: feature",
					"  color: 0e8a16",
					"",
					"# Area labels",
					"- name: area:tests",
				].join("\n"),
			),
		).toEqual(["bug", "feature"]);
	});

	it("throws when the marker section is missing (fail loud, not a silent empty set)", () => {
		expect(() => deriveTypeLabels("# Area labels\n- name: area:tests")).toThrow(
			/no "# Type labels" section/,
		);
	});

	it("throws when the block is present but yields zero names", () => {
		expect(() => deriveTypeLabels("# Type labels\n\n# Area labels")).toThrow(
			/derived zero TYPE labels/,
		);
	});

	it("the live .github/labels.yml derivation matches AGENTS.md's own TYPE list", () => {
		// Cheap drift guard: the four names AGENTS.md's "Issue triage & labels"
		// section names by hand. tests/config/label-manifest-coverage.test.ts
		// already polices the manifest against AGENTS.md in the OTHER
		// direction (a label AGENTS.md requires must exist in the manifest);
		// this is the narrow slice of that same check this module actually
		// depends on.
		expect(new Set(TYPE_LABELS)).toEqual(
			new Set(["bug", "feature", "enhancement", "documentation"]),
		);
	});
});

describe("isTrackingIssueTitle (#3563)", () => {
	it.each([
		"tracking: TLA+ findings and follow-up work queue",
		"Tracking: some queue",
		"  tracking: leading whitespace",
	])("%s is a tracking issue", (title) => {
		expect(isTrackingIssueTitle(title)).toBe(true);
	});

	it.each([
		"ci: flag open issues that carry no type or priority label",
		"a tracking issue mentioned mid-sentence",
		"",
	])("%s is not a tracking issue", (title) => {
		expect(isTrackingIssueTitle(title)).toBe(false);
	});
});

describe("hasTypeLabel / hasPriorityLabel (#3563)", () => {
	it("matches a TYPE label case-insensitively", () => {
		expect(hasTypeLabel([{ name: "Enhancement" }])).toBe(true);
		expect(hasTypeLabel([{ name: "area:tests" }])).toBe(false);
	});

	it("matches priority:p<n> for any n, case-insensitively", () => {
		expect(hasPriorityLabel([{ name: "priority:p1" }])).toBe(true);
		expect(hasPriorityLabel([{ name: "PRIORITY:P4" }])).toBe(true);
		expect(hasPriorityLabel([{ name: "priority:pending" }])).toBe(false);
	});

	it("tolerates a plain-string labels array (not just {name} objects)", () => {
		expect(hasTypeLabel(["bug"])).toBe(true);
		expect(hasPriorityLabel(["priority:p2"])).toBe(true);
	});
});

describe("isUntriagedIssue (#3563)", () => {
	it("flags an issue with neither label (the incident's own #3543 shape)", () => {
		expect(isUntriagedIssue(issue({ number: 3543, title: "some fix" }))).toBe(
			true,
		);
	});

	it("does not flag an issue carrying both a TYPE and a priority label", () => {
		expect(
			isUntriagedIssue(
				issue({
					number: 3563,
					title: "ci: flag open issues",
					labels: ["enhancement", "area:tests", "priority:p2"],
				}),
			),
		).toBe(false);
	});

	it("flags an issue with a TYPE label but no priority label", () => {
		expect(
			isUntriagedIssue(issue({ number: 1, title: "x", labels: ["bug"] })),
		).toBe(true);
	});

	it("flags an issue with a priority label but no TYPE label", () => {
		expect(
			isUntriagedIssue(
				issue({ number: 2, title: "x", labels: ["priority:p3"] }),
			),
		).toBe(true);
	});

	it("a tracking: issue needs only a priority label, not a TYPE label (#3518's own shape)", () => {
		expect(
			isUntriagedIssue(
				issue({
					number: 3518,
					title: "tracking: TLA+ findings and follow-up work queue",
					labels: ["priority:p2"],
				}),
			),
		).toBe(false);
	});

	it("a tracking: issue is STILL flagged if it has no priority label at all", () => {
		expect(
			isUntriagedIssue(
				issue({
					number: 3518,
					title: "tracking: TLA+ findings",
					labels: [],
				}),
			),
		).toBe(true);
	});

	it("never flags a pull request (the issues-list endpoint returns PRs too)", () => {
		expect(
			isUntriagedIssue(
				issue({ number: 99, title: "a PR", labels: [], pull_request: {} }),
			),
		).toBe(false);
	});
});

describe("findUntriagedIssues / formatUntriagedReport (#3563)", () => {
	const fixture = [
		issue({ number: 3543, title: "unlabelled fix" }), // missing both
		issue({
			number: 3563,
			title: "ci: flag open issues",
			labels: ["enhancement", "area:tests", "priority:p2"],
		}), // clean
		issue({
			number: 3518,
			title: "tracking: TLA+ findings",
			labels: ["priority:p2"],
		}), // clean (tracking exemption)
		issue({ number: 42, title: "has a PR marker", pull_request: {} }), // never flagged
	];

	it("passes once the incident's issue is labelled (acceptance criterion)", () => {
		// The fixture set as it exists WITH #3543 unlabelled: fails.
		expect(findUntriagedIssues(fixture)).toHaveLength(1);
		// The same set with #3543 now labelled: passes.
		const labelled = fixture.map((entry) =>
			entry.number === 3543
				? { ...entry, labels: ["bug", "priority:p2"] }
				: entry,
		);
		expect(findUntriagedIssues(labelled)).toHaveLength(0);
	});

	it("names which label(s) are missing per issue", () => {
		const result = findUntriagedIssues(fixture);
		expect(result).toEqual([
			{ issue: fixture[0], missing: ["type", "priority"] },
		]);
	});

	it("the red output names the issue and what it is missing", () => {
		const report = formatUntriagedReport(findUntriagedIssues(fixture));
		expect(report).toContain("#3543");
		expect(report).toContain("missing: type, priority");
	});

	it("reports 'None.' when nothing is untriaged", () => {
		expect(formatUntriagedReport([])).toContain("None.");
	});
});
