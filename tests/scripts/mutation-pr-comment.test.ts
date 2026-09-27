import { describe, expect, it } from "vitest";
import { findStickyCommentId } from "../../scripts/lib/mutation-pr-comment.mjs";
import { STICKY_MARKER } from "../../scripts/lib/mutation-report-render.mjs";

const BOT = { login: "github-actions[bot]" };

describe("findStickyCommentId", () => {
	it("finds the bot's comment carrying the sticky marker among unrelated comments", () => {
		const comments = [
			{ id: 1, body: "just a review note", user: { login: "a-reviewer" } },
			{
				id: 2,
				body: `${STICKY_MARKER}\n### Mutation diff (advisory)\n...`,
				user: BOT,
			},
			{ id: 3, body: "lgtm", user: { login: "a-reviewer" } },
		];

		expect(findStickyCommentId(comments, STICKY_MARKER)).toBe(2);
	});

	it("returns null when no comment carries the marker, so the caller posts a new one", () => {
		// Recurrence: a sticky comment that can never be found the first time
		// (e.g. the marker text drifts from what was posted) piles up a new
		// comment on every push instead of updating in place.
		const comments = [{ id: 1, body: "unrelated", user: BOT }];

		expect(findStickyCommentId(comments, STICKY_MARKER)).toBeNull();
	});

	it("returns null against an empty comment list", () => {
		expect(findStickyCommentId([], STICKY_MARKER)).toBeNull();
	});

	it("tolerates a comment with no body", () => {
		expect(
			findStickyCommentId([{ id: 1, user: BOT }], STICKY_MARKER),
		).toBeNull();
	});

	it("picks the first bot match when (unexpectedly) more than one of the bot's own comments carries the marker", () => {
		const comments = [
			{ id: 5, body: `${STICKY_MARKER} old`, user: BOT },
			{ id: 9, body: `${STICKY_MARKER} newer`, user: BOT },
		];

		expect(findStickyCommentId(comments, STICKY_MARKER)).toBe(5);
	});

	it("round 2 T2: ignores a HUMAN comment that carries the marker (a pasted report, or the report's own markdown quoted back)", () => {
		// Recurrence: matching on the marker alone picks whichever comment
		// carries it first, regardless of author. If a human posts the marker
		// before the bot's first run, the bot's token then either PATCHes that
		// stranger's comment (the report starts appearing under their name,
		// editable by them) or gets a 403 and the PR never gets a report.
		const comments = [
			{
				id: 1,
				body: `I ran this locally, here's the output:\n\n${STICKY_MARKER}\n### Mutation diff (advisory)\n...`,
				user: { login: "a-human-fixer" },
			},
			{
				id: 2,
				body: `${STICKY_MARKER}\n### Mutation diff (advisory)\n...`,
				user: BOT,
			},
		];

		expect(findStickyCommentId(comments, STICKY_MARKER)).toBe(2);
	});

	it("returns null when only a human's comment carries the marker -- the bot posts a new one rather than adopting it", () => {
		const comments = [
			{
				id: 1,
				body: `${STICKY_MARKER}\n### Mutation diff (advisory)\n...`,
				user: { login: "a-human-fixer" },
			},
		];

		expect(findStickyCommentId(comments, STICKY_MARKER)).toBeNull();
	});

	it("#3592 item 3: skips a comment with no `user` field at all, rather than throwing (survivor: mutation-pr-comment.mjs:30, comment.user?.login -> comment.user.login)", () => {
		// Recurrence: none of the pre-#3592 fixtures ever paired a marker-
		// carrying `body` with a comment that has NO `user` key at all -- the
		// "no body" case above still sets `user: BOT`. Without the `?.`, a
		// comment shaped like this (a real possibility from the GitHub API,
		// e.g. a since-deleted account) throws `TypeError: Cannot read
		// properties of undefined (reading 'login')` out of `.find`, crashing
		// the whole lookup instead of just skipping that one comment.
		const comments = [
			{ id: 1, body: STICKY_MARKER },
			{ id: 2, body: STICKY_MARKER, user: BOT },
		];

		expect(() => findStickyCommentId(comments, STICKY_MARKER)).not.toThrow();
		expect(findStickyCommentId(comments, STICKY_MARKER)).toBe(2);
	});

	it("accepts a caller-supplied bot login instead of the default", () => {
		const comments = [
			{ id: 1, body: STICKY_MARKER, user: { login: "some-other-bot[bot]" } },
		];

		expect(
			findStickyCommentId(comments, STICKY_MARKER, "some-other-bot[bot]"),
		).toBe(1);
		expect(findStickyCommentId(comments, STICKY_MARKER)).toBeNull();
	});
});
