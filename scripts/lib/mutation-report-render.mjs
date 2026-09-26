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

	// round 2 R2-1: shared by the zero-mutant and the scored path below, so a
	// run that sampled ranges down and then found nothing still SAYS it
	// sampled -- previously the zero-mutant branch returned before this note
	// was ever built, so a false-looking "no mutable code in M ranges" verdict
	// carried no hint that only a subset of M was actually tried.
	const samplingNote = meta.rangesSampled
		? `_Sampled ${meta.rangesEvaluated ?? "?"} of ${meta.rangesTotal ?? "?"} changed-line ranges deterministically (seed \`${shortSha(meta.headSha)}\`)._`
		: null;

	if (meta.zeroMutants) {
		lines.push(
			"**0 mutants evaluated.** This is not a clean pass -- it means the lane found nothing to mutate or could not finish.",
			"",
			`> ${meta.zeroMutants.reason}`,
			"",
		);
		if (samplingNote) lines.push(samplingNote, "");
		lines.push(metaTable(meta));
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

	if (samplingNote) lines.push(samplingNote, "");

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
 * `upstreamResult` (round 2 R2-4), when the caller can supply it (the
 * `mutation-comment` workflow job passes `needs.mutation.result`),
 * distinguishes a run the new per-PR concurrency group cancelled outright
 * from one that crashed or hit its own time cap -- neither of which it
 * actually did. With no reliable signal either way, the wording stays
 * neutral rather than guessing "crashed" for what may just be a cancellation.
 *
 * @param {{headSha?: string, runUrl?: string, upstreamResult?: string}} [context]
 * @returns {string} markdown
 */
export function renderStaleMarkdown({ headSha, runUrl, upstreamResult } = {}) {
	const cause =
		upstreamResult === "cancelled"
			? "a newer push to this PR superseded it before it produced one"
			: "it did not produce one (a crash, or hitting its overall time cap, are both possible; this cannot always be told apart from a cancellation)";
	const lines = [
		STICKY_MARKER,
		"### Mutation diff (advisory)",
		"",
		`**Stale.** This head (\`${shortSha(headSha)}\`) produced no mutation report -- ${cause} (distinct from the driver's own, narrower Stryker budget, which always writes a report even when Stryker itself times out).`,
		"",
		"This comment has just been updated to say so; any result it previously showed was for a different, earlier commit and no longer reflects this PR's current head.",
	];
	if (runUrl) lines.push("", `[Job run](${runUrl})`);
	return lines.join("\n");
}

export { STICKY_MARKER };
