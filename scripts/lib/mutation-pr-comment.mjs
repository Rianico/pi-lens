/**
 * Finds this lane's own sticky mutation-diff comment among a PR's issue
 * comments, so scripts/mutation-pr-comment.mjs can update it in place
 * instead of piling up a new comment on every push (#3531).
 *
 * Pure and network-free: the CLI script does the `gh api` listing and
 * PATCH/POST, this only decides WHICH comment (if any) to update.
 *
 * @param {Array<{id: number, body?: string}>} comments
 * @param {string} marker the sticky marker (STICKY_MARKER from
 *   mutation-report-render.mjs)
 * @returns {number | null}
 */
export function findStickyCommentId(comments, marker) {
	const existing = comments.find((comment) => comment.body?.includes(marker));
	return existing ? existing.id : null;
}
