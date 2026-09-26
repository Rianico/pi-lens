/**
 * Renders the driver's `reports/mutation/mutation.json` (Stryker's own
 * report augmented with a `piLensMutationDiff` key -- see
 * scripts/stryker-diff.mjs's writeReport) as the markdown used for the job
 * summary and the sticky PR comment, and by `scripts/mutation-report.mjs`
 * for a fixer or reviewer citing PR evidence directly (#3531).
 *
 * Pure and file-I/O-free so it is unit-testable against literal report
 * fixtures; scripts/mutation-report.mjs and the workflow step are the only
 * callers that touch the filesystem.
 */

const STICKY_MARKER = "<!-- pi-lens-mutation-diff -->";

function shortSha(sha) {
	return typeof sha === "string" ? sha.slice(0, 12) : "unknown";
}

function metaTable(meta) {
	const rows = [
		["Base", meta.base ?? "?"],
		["Head", `\`${shortSha(meta.headSha)}\``],
	];
	if ((meta.filesSkippedOverCap?.length ?? 0) > 0) {
		rows.push([
			"Skipped (over --max-files)",
			meta.filesSkippedOverCap.join(", "),
		]);
	}
	if ((meta.filesUncovered?.length ?? 0) > 0) {
		rows.push(["No covering test", meta.filesUncovered.join(", ")]);
	}
	return rows.map(([k, v]) => `- **${k}:** ${v}`).join("\n");
}

/**
 * @param {object} report a parsed reports/mutation/mutation.json
 * @returns {string} markdown
 */
export function renderMutationMarkdown(report) {
	const meta = report?.piLensMutationDiff ?? {};
	const lines = [STICKY_MARKER, "### Mutation diff (advisory)", ""];

	if (meta.zeroMutants) {
		lines.push(
			"**0 mutants evaluated.** This is not a clean pass -- it means the lane found nothing to mutate or could not finish.",
			"",
			`> ${meta.zeroMutants.reason}`,
			"",
			metaTable(meta),
		);
		return lines.join("\n");
	}

	const counts = meta.counts ?? {};
	const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
	const survivors = Object.entries(report.files ?? {}).flatMap(
		([fileName, file]) =>
			(file.mutants ?? [])
				.filter((m) => m.status === "Survived")
				.map((mutant) => ({ ...mutant, fileName })),
	);

	// round 2 S2: a budget kill can still leave a real, partial result --
	// labelled here so it is never confused with a run that evaluated every
	// range it set out to.
	if (meta.partial) {
		lines.push(
			`**Partial run** -- ${meta.partial.evaluated} of ${meta.partial.total ?? "an unknown total of"} mutant(s) evaluated before the budget expired.`,
			"",
			`> ${meta.partial.reason}`,
			"",
		);
	}

	lines.push(
		`**Score: ${meta.score ?? "n/a"}%** -- ${counts.Killed ?? 0} killed, ${counts.Survived ?? 0} survived, ${counts.Timeout ?? 0} timeout, ${counts.NoCoverage ?? 0} no coverage (${total} total)`,
		"",
	);

	if (meta.rangesSampled) {
		lines.push(
			`_Sampled ${meta.rangesEvaluated ?? "?"} of ${meta.rangesTotal ?? "?"} changed-line ranges deterministically (seed \`${shortSha(meta.headSha)}\`)._`,
			"",
		);
	}

	if (survivors.length > 0) {
		lines.push(`#### Survivors (${survivors.length})`, "");
		lines.push("| Location | Mutator | Original → Replacement |");
		lines.push("|---|---|---|");
		for (const mutant of survivors) {
			const location = mutant.tsLocation
				? `${mutant.tsLocation.fileName}:${mutant.tsLocation.line}`
				: `${mutant.fileName}:${mutant.location?.start?.line ?? "?"}`;
			const original = (mutant.original ?? "").replaceAll("|", "\\|");
			const replacement = (mutant.replacement ?? "").replaceAll("|", "\\|");
			lines.push(
				`| \`${location}\` | ${mutant.mutatorName} | \`${original}\` → \`${replacement}\` |`,
			);
		}
		lines.push("");
	} else {
		lines.push("No survivors.", "");
	}

	lines.push(metaTable(meta));
	if ((meta.testsRun?.length ?? 0) > 0) {
		lines.push(
			"",
			`<details><summary>Tests run (${meta.testsRun.length})</summary>\n\n${meta.testsRun.map((t) => `- \`${t}\``).join("\n")}\n\n</details>`,
		);
	}

	return lines.join("\n");
}

/**
 * Renders the sticky comment's body when THIS head produced no artifact to
 * download at all (round 2 T6): the driver crashed before `writeReport`, or
 * the job hit its 90-minute `timeout-minutes` cap outright. Without this,
 * the comment job's download step simply has nothing to post, and an
 * earlier head's report -- now stale, about a commit this PR no longer is
 * -- stays up with no indication it no longer applies to the current head.
 * Carries the same `STICKY_MARKER` so a later successful run still finds
 * and updates this same comment rather than posting a second one.
 *
 * @param {{headSha?: string, runUrl?: string}} [context]
 * @returns {string} markdown
 */
export function renderStaleMarkdown({ headSha, runUrl } = {}) {
	const lines = [
		STICKY_MARKER,
		"### Mutation diff (advisory)",
		"",
		`**Stale.** This head (\`${shortSha(headSha)}\`) produced no mutation report -- the job likely crashed before writing one, or hit its overall time cap outright (distinct from the driver's own, narrower Stryker budget, which always writes a report even when Stryker itself times out).`,
		"",
		"This comment is left over from an earlier, different commit and no longer reflects this PR's current head.",
	];
	if (runUrl) lines.push("", `[Job run](${runUrl})`);
	return lines.join("\n");
}

export { STICKY_MARKER };
