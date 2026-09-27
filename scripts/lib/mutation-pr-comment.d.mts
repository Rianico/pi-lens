export declare function findStickyCommentId(
	comments: Array<{ id: number; body?: string; user?: { login?: string } }>,
	marker: string,
	botLogin?: string,
): number | null;
