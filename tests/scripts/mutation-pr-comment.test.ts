import { describe, expect, it } from "vitest";
import { findStickyCommentId } from "../../scripts/lib/mutation-pr-comment.mjs";
import { STICKY_MARKER } from "../../scripts/lib/mutation-report-render.mjs";

describe("findStickyCommentId", () => {
	it("finds the comment carrying the sticky marker among unrelated comments", () => {
		const comments = [
			{ id: 1, body: "just a review note" },
			{ id: 2, body: `${STICKY_MARKER}\n### Mutation diff (advisory)\n...` },
			{ id: 3, body: "lgtm" },
		];

		expect(findStickyCommentId(comments, STICKY_MARKER)).toBe(2);
	});

	it("returns null when no comment carries the marker, so the caller posts a new one", () => {
		// Recurrence: a sticky comment that can never be found the first time
		// (e.g. the marker text drifts from what was posted) piles up a new
		// comment on every push instead of updating in place.
		const comments = [{ id: 1, body: "unrelated" }];

		expect(findStickyCommentId(comments, STICKY_MARKER)).toBeNull();
	});

	it("returns null against an empty comment list", () => {
		expect(findStickyCommentId([], STICKY_MARKER)).toBeNull();
	});

	it("tolerates a comment with no body", () => {
		expect(findStickyCommentId([{ id: 1 }], STICKY_MARKER)).toBeNull();
	});

	it("picks the first match when (unexpectedly) more than one comment carries the marker", () => {
		const comments = [
			{ id: 5, body: `${STICKY_MARKER} old` },
			{ id: 9, body: `${STICKY_MARKER} newer` },
		];

		expect(findStickyCommentId(comments, STICKY_MARKER)).toBe(5);
	});
});
