import { describe, expect, it } from "vitest";
import {
	fetchOpenIssues,
	MAX_PAGES,
	PAGE_SIZE,
} from "../../scripts/lib/label-triage.mjs";

function fakeGithub(pages: unknown[][]) {
	const calls: string[] = [];
	const fetchImpl = async (url: string) => {
		calls.push(url);
		const page = Number(new URL(url).searchParams.get("page"));
		return { ok: true, status: 200, json: async () => pages[page - 1] ?? [] };
	};
	return { fetchImpl, calls };
}

describe("fetchOpenIssues (#3563)", () => {
	it("reads a single short page", async () => {
		const { fetchImpl, calls } = fakeGithub([[{ number: 1 }, { number: 2 }]]);
		const issues = await fetchOpenIssues("acme/repo", "tok", fetchImpl);
		expect(issues).toEqual([{ number: 1 }, { number: 2 }]);
		expect(calls).toEqual([
			`https://api.github.com/repos/acme/repo/issues?state=open&per_page=${PAGE_SIZE}&page=1`,
		]);
	});

	it("pages until a short (non-full) page is returned", async () => {
		const fullPage = Array.from({ length: PAGE_SIZE }, (_, i) => ({
			number: i,
		}));
		const { fetchImpl, calls } = fakeGithub([fullPage, [{ number: 999 }]]);
		const issues = await fetchOpenIssues("acme/repo", "tok", fetchImpl);
		expect(issues).toHaveLength(PAGE_SIZE + 1);
		expect(calls).toHaveLength(2);
	});

	it("fails closed rather than using a partial list past the page bound", async () => {
		const fullPage = Array.from({ length: PAGE_SIZE }, (_, i) => ({
			number: i,
		}));
		const { fetchImpl } = fakeGithub(
			Array.from({ length: MAX_PAGES + 1 }, () => fullPage),
		);
		await expect(
			fetchOpenIssues("acme/repo", "tok", fetchImpl),
		).rejects.toThrow(/pagination bound/);
	});

	it("throws on a non-ok response instead of reading it as zero issues", async () => {
		const fetchImpl = async () => ({
			ok: false,
			status: 403,
			json: async () => [],
		});
		await expect(
			fetchOpenIssues("acme/repo", "tok", fetchImpl),
		).rejects.toThrow(/403/);
	});

	it("sends the bearer token on every request", async () => {
		let seenAuth: string | undefined;
		const fetchImpl = async (_url: string, init?: RequestInit) => {
			const headers = init?.headers as Record<string, string> | undefined;
			seenAuth = headers?.Authorization;
			return { ok: true, status: 200, json: async () => [] };
		};
		await fetchOpenIssues("acme/repo", "sekrit", fetchImpl);
		expect(seenAuth).toBe("Bearer sekrit");
	});
});
