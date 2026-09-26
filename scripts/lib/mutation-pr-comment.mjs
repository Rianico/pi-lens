/**
 * Finds this lane's own sticky mutation-diff comment among a PR's issue
 * comments, so scripts/mutation-pr-comment.mjs can update it in place
 * instead of piling up a new comment on every push (#3531).
 *
 * Pure and network-free: the CLI script does the `gh api` listing and
 * PATCH/POST, this only decides WHICH comment (if any) to update.
 *
 * Matches on the marker AND the author (round 2 T2): a human who pastes a
 * copy of a past report -- or the report's own markdown -- into a comment
 * also carries the marker, and matching on the marker alone picks THAT
 * comment. The bot's token then either PATCHes a stranger's comment (the
 * report starts appearing under their name, and they can edit it) or gets a
 * 403 and the PR never gets a report, depending on who posted first.
 *
 * @param {Array<{id: number, body?: string, user?: {login?: string}}>} comments
 * @param {string} marker the sticky marker (STICKY_MARKER from
 *   mutation-report-render.mjs)
 * @param {string} [botLogin] the account whose comments this lane may
 *   update; GitHub Actions' default token authors as `github-actions[bot]`
 * @returns {number | null}
 */
export function findStickyCommentId(
	comments,
	marker,
	botLogin = "github-actions[bot]",
) {
	const existing = comments.find(
		(comment) =>
			comment.body?.includes(marker) && comment.user?.login === botLogin,
	);
	return existing ? existing.id : null;
}
