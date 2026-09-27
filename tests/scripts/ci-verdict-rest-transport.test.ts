import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	computeVerdict,
	EXIT_DIRTY,
	EXIT_FAILURE,
	EXIT_PENDING,
	EXIT_SUCCESS,
	EXIT_TRANSPORT,
	extractRequiredCheckNames,
	isGhMissingError,
	mapRestMergeableState,
	MIN_GH_TIMEOUT_MS,
	parseOwnerRepoFromGitRemote,
	resolveGithubApiBase,
	resolveGithubToken,
	resolveRepositoryViaGit,
	resolveRequiredCheckNames,
	resolveTransport,
	restFetchCheckRunsPayload,
	restResolveHeadSha,
	restResolveRequiredCheckNames,
	run,
	TRANSPORT_GH,
	TRANSPORT_REST,
} from "../../scripts/ci-verdict.mjs";

/**
 * #3497: the REST transport this script uses when `gh` is not on PATH but a
 * `GH_TOKEN`/`GITHUB_TOKEN` is available -- the Claude Code cloud
 * container's own shape (see the module's `TRANSPORT_GH`/`TRANSPORT_REST`
 * doc comment). Lives in its own file rather than `ci-verdict.test.ts`
 * (owned by G19's mutation-lane round, per this batch's brief) -- purely a
 * file-ownership boundary, not a design choice; every case here would sit
 * naturally beside that file's existing `resolveRequiredCheckNames` /
 * `fetchCheckRunsPayload` / `resolveHeadSha` describe blocks.
 *
 * Red-first proof (this repo's own sandbox has no `gh` on PATH, and its
 * session carries a real `GH_TOKEN` via the outbound proxy -- exactly the
 * #3497 incident shape): before any of this file's production code existed,
 *
 *   $ which gh; echo "gh on PATH: $?"
 *   gh on PATH: 1
 *   $ GH_TOKEN=faketoken123 node scripts/ci-verdict.mjs 3497
 *   spawnSync gh ENOENT
 *   EXIT_CODE=70
 *
 * -- today's script exits 70 even with a token set, which is the exact
 * acceptance criterion. `resolveTransport`'s own tests below reproduce this
 * decision as a pure function; the `run()` case further down reproduces it
 * end-to-end with `PATH` genuinely emptied for the duration of the test.
 */

function checkRun({
	name,
	status = "completed",
	conclusion = "success",
	id = 1,
}: {
	name: string;
	status?: string;
	conclusion?: string | null;
	id?: number;
}) {
	return {
		name,
		status,
		conclusion,
		started_at: "2026-09-03T00:00:00Z",
		id,
		html_url: `https://github.com/apmantza/pi-lens/actions/runs/${id}`,
		details_url: `https://github.com/apmantza/pi-lens/actions/runs/${id}/job/${id}`,
	};
}

const REAL_CHECK_RUNS = JSON.parse(
	readFileSync(
		join(process.cwd(), "tests/fixtures/ci-verdict/real-check-runs.json"),
		"utf8",
	),
);

describe("resolveGithubToken (#3497)", () => {
	it("prefers GH_TOKEN over GITHUB_TOKEN, matching gh's own documented precedence", () => {
		expect(
			resolveGithubToken({ GH_TOKEN: "gh-token", GITHUB_TOKEN: "gha-token" }),
		).toBe("gh-token");
	});

	it("falls back to GITHUB_TOKEN when GH_TOKEN is unset", () => {
		expect(resolveGithubToken({ GITHUB_TOKEN: "gha-token" })).toBe("gha-token");
	});

	it("returns null when neither is set, or is set empty", () => {
		expect(resolveGithubToken({})).toBeNull();
		expect(resolveGithubToken({ GH_TOKEN: "", GITHUB_TOKEN: "" })).toBeNull();
	});
});

describe("resolveGithubApiBase (#3497)", () => {
	it("defaults to the public API", () => {
		expect(resolveGithubApiBase({})).toBe("https://api.github.com");
	});

	it("honors GITHUB_API_URL for GitHub Enterprise Server", () => {
		expect(
			resolveGithubApiBase({
				GITHUB_API_URL: "https://ghe.example.com/api/v3",
			}),
		).toBe("https://ghe.example.com/api/v3");
	});
});

describe("isGhMissingError (#3497)", () => {
	it("is true only for an ENOENT-coded Error", () => {
		expect(
			isGhMissingError(Object.assign(new Error("x"), { code: "ENOENT" })),
		).toBe(true);
	});

	it("is false for any other error shape, including a non-Error", () => {
		expect(
			isGhMissingError(Object.assign(new Error("x"), { code: "EACCES" })),
		).toBe(false);
		expect(isGhMissingError(new Error("gh auth login"))).toBe(false);
		expect(isGhMissingError("boom")).toBe(false);
		expect(isGhMissingError(undefined)).toBe(false);
	});
});

describe("parseOwnerRepoFromGitRemote (#3497)", () => {
	it.each([
		["https://github.com/apmantza/pi-lens.git", "apmantza/pi-lens"],
		["https://github.com/apmantza/pi-lens", "apmantza/pi-lens"],
		["git@github.com:apmantza/pi-lens.git", "apmantza/pi-lens"],
		["https://github.com/apmantza/pi-lens.git/", "apmantza/pi-lens"],
	])("parses %s as %s", (remote, expected) => {
		expect(parseOwnerRepoFromGitRemote(remote)).toBe(expected);
	});

	it("returns null for a non-GitHub remote", () => {
		expect(
			parseOwnerRepoFromGitRemote("https://gitlab.com/acme/repo.git"),
		).toBeNull();
	});

	it("returns null for garbage input", () => {
		expect(parseOwnerRepoFromGitRemote("")).toBeNull();
		expect(parseOwnerRepoFromGitRemote(undefined)).toBeNull();
	});
});

describe("resolveRepositoryViaGit (#3497)", () => {
	it("reads owner/repo from `git remote get-url origin`", () => {
		const gitExec = (bin: string, args: string[]) => {
			expect(bin).toBe("git");
			expect(args).toEqual(["remote", "get-url", "origin"]);
			return "https://github.com/apmantza/pi-lens.git\n";
		};
		expect(resolveRepositoryViaGit(gitExec)).toBe("apmantza/pi-lens");
	});

	it("throws when the remote cannot be parsed as owner/repo", () => {
		const gitExec = () => "https://example.com/not-github\n";
		expect(() => resolveRepositoryViaGit(gitExec)).toThrow(/could not parse/);
	});
});

describe("mapRestMergeableState (#3497)", () => {
	it("maps mergeable_state=dirty to CONFLICTING", () => {
		expect(
			mapRestMergeableState({ mergeable: false, mergeable_state: "dirty" }),
		).toBe("CONFLICTING");
	});

	it("maps mergeable=true to MERGEABLE", () => {
		expect(
			mapRestMergeableState({ mergeable: true, mergeable_state: "clean" }),
		).toBe("MERGEABLE");
	});

	it.each(["unstable", "blocked", "unknown", "draft", undefined])(
		"maps mergeable_state=%s (mergeable not true) to UNKNOWN",
		(state) => {
			expect(
				mapRestMergeableState({ mergeable: null, mergeable_state: state }),
			).toBe("UNKNOWN");
		},
	);

	it("maps a missing pull request payload to UNKNOWN, not a throw", () => {
		expect(mapRestMergeableState(undefined)).toBe("UNKNOWN");
	});
});

describe("extractRequiredCheckNames (#3497 -- shared by gh and REST)", () => {
	it("prefers checks[].context over the legacy contexts array", () => {
		expect(
			extractRequiredCheckNames({
				checks: [{ context: "Unit tests" }, { context: "Lint & type-check" }],
				contexts: ["stale"],
			}),
		).toEqual(["Unit tests", "Lint & type-check"]);
	});

	it("falls back to contexts when checks is absent or empty", () => {
		expect(extractRequiredCheckNames({ contexts: ["Unit tests"] })).toEqual([
			"Unit tests",
		]);
		expect(
			extractRequiredCheckNames({ checks: [], contexts: ["Unit tests"] }),
		).toEqual(["Unit tests"]);
	});

	it("returns null when nothing usable is present", () => {
		expect(extractRequiredCheckNames({})).toBeNull();
		expect(extractRequiredCheckNames(undefined)).toBeNull();
	});

	// Behavior-preservation proof for the extraction out of
	// `resolveRequiredCheckNames` (#3497): same gh-path inputs must still
	// produce the same output through the call-through, matching the 43
	// pre-existing `resolveRequiredCheckNames` tests in the owned
	// ci-verdict.test.ts (all 132 of that file's tests stayed green after
	// this extraction -- quoted in the PR body).
	it("resolveRequiredCheckNames still returns the identical value through the shared extraction", () => {
		const ghExec = () =>
			JSON.stringify({
				required_status_checks: {
					checks: [{ context: "Unit tests" }, { context: "Lint & type-check" }],
				},
			});
		expect(resolveRequiredCheckNames("acme/repo", ghExec)).toEqual([
			"Unit tests",
			"Lint & type-check",
		]);
	});
});

describe("restResolveHeadSha (#3497)", () => {
	it("resolves a PR number via GET .../pulls/<n>, reading head.sha and mergeable_state", async () => {
		const calls: string[] = [];
		const fetchImpl = async (url: string) => {
			calls.push(url);
			return new Response(
				JSON.stringify({
					head: { sha: "c0ffee" },
					mergeable: true,
					mergeable_state: "clean",
				}),
			);
		};
		const result = await restResolveHeadSha("acme/repo", "2539", {
			token: "tok",
			fetchImpl,
		});
		expect(result).toEqual({ sha: "c0ffee", mergeable: "MERGEABLE" });
		expect(calls).toEqual([
			"https://api.github.com/repos/acme/repo/pulls/2539",
		]);
	});

	it("resolves a bare SHA target with no fetch at all", async () => {
		const fetchImpl = async () => {
			throw new Error("must not fetch for a bare-SHA target");
		};
		const result = await restResolveHeadSha("acme/repo", "abc1234", {
			token: "tok",
			fetchImpl,
		});
		expect(result).toEqual({ sha: "abc1234", mergeable: null });
	});
});

describe("restFetchCheckRunsPayload (#3497)", () => {
	it("reads every page until total_count is covered (parity with fetchCheckRunsPayload's own #3373 fixture)", async () => {
		const calls: string[] = [];
		const fetchImpl = async (url: string) => {
			calls.push(url);
			const page = Number(new URL(url).searchParams.get("page"));
			return new Response(
				JSON.stringify({
					total_count: REAL_CHECK_RUNS.source.total_count,
					check_runs: REAL_CHECK_RUNS.pages[page - 1] ?? [],
				}),
			);
		};
		const payload = await restFetchCheckRunsPayload(
			"apmantza/pi-lens",
			"head",
			{
				token: "tok",
				fetchImpl,
			},
		);
		expect(calls).toEqual([
			"https://api.github.com/repos/apmantza/pi-lens/commits/head/check-runs?per_page=100&page=1",
			"https://api.github.com/repos/apmantza/pi-lens/commits/head/check-runs?per_page=100&page=2",
		]);
		expect(payload.check_runs).toHaveLength(REAL_CHECK_RUNS.source.total_count);
	});

	// The four acceptance-criterion fixtures: computeVerdict must reach the
	// SAME exit code from a REST-shaped payload as it does from the
	// equivalent gh-shaped one (already proven correct by the 132
	// pre-existing ci-verdict.test.ts cases) -- proving the REST fetch
	// function hands computeVerdict an equivalent payload, not a second
	// verdict policy.
	function fetchImplFor(checkRuns: unknown[]) {
		return async () =>
			new Response(
				JSON.stringify({
					total_count: checkRuns.length,
					check_runs: checkRuns,
				}),
			);
	}

	it("green head: both required checks succeed -> EXIT_SUCCESS", async () => {
		const payload = await restFetchCheckRunsPayload("acme/repo", "sha1", {
			token: "tok",
			fetchImpl: fetchImplFor([
				checkRun({ name: "Unit tests", id: 1 }),
				checkRun({ name: "Lint & type-check", id: 2 }),
			]),
		});
		expect(computeVerdict(payload, undefined, "MERGEABLE").exitCode).toBe(
			EXIT_SUCCESS,
		);
	});

	it("a failed required check -> EXIT_FAILURE", async () => {
		const payload = await restFetchCheckRunsPayload("acme/repo", "sha2", {
			token: "tok",
			fetchImpl: fetchImplFor([
				checkRun({ name: "Unit tests", conclusion: "failure", id: 1 }),
				checkRun({ name: "Lint & type-check", id: 2 }),
			]),
		});
		expect(computeVerdict(payload, undefined, "MERGEABLE").exitCode).toBe(
			EXIT_FAILURE,
		);
	});

	it("an absent required check (not CONFLICTING) -> EXIT_PENDING", async () => {
		const payload = await restFetchCheckRunsPayload("acme/repo", "sha3", {
			token: "tok",
			fetchImpl: fetchImplFor([checkRun({ name: "Unit tests", id: 1 })]),
		});
		expect(computeVerdict(payload, undefined, "MERGEABLE").exitCode).toBe(
			EXIT_PENDING,
		);
	});

	it("a latest cancelled required run -> EXIT_PENDING, not EXIT_SUCCESS (#3373's own required cancellation shape)", async () => {
		const payload = await restFetchCheckRunsPayload("acme/repo", "sha4", {
			token: "tok",
			fetchImpl: fetchImplFor([
				checkRun({ name: "Unit tests", conclusion: "cancelled", id: 1 }),
				checkRun({ name: "Lint & type-check", id: 2 }),
			]),
		});
		expect(computeVerdict(payload, undefined, "MERGEABLE").exitCode).toBe(
			EXIT_PENDING,
		);
	});

	it("mutation table row: same shape but CONFLICTING -> EXIT_DIRTY beats the green rows above", async () => {
		const payload = await restFetchCheckRunsPayload("acme/repo", "sha5", {
			token: "tok",
			fetchImpl: fetchImplFor([
				checkRun({ name: "Unit tests", id: 1 }),
				checkRun({ name: "Lint & type-check", id: 2 }),
			]),
		});
		expect(computeVerdict(payload, undefined, "CONFLICTING").exitCode).toBe(
			EXIT_DIRTY,
		);
	});
});

describe("restResolveRequiredCheckNames (#3497)", () => {
	it("returns the live contexts on a readable branch-protection response", async () => {
		const fetchImpl = async () =>
			new Response(
				JSON.stringify({
					required_status_checks: {
						contexts: ["Unit tests", "Lint & type-check"],
					},
				}),
			);
		expect(
			await restResolveRequiredCheckNames("acme/repo", {
				token: "tok",
				fetchImpl,
			}),
		).toEqual(["Unit tests", "Lint & type-check"]);
	});

	it("returns null on a 403/404, matching the gh path's fail-open contract", async () => {
		const fetchImpl = async () => new Response("", { status: 403 });
		expect(
			await restResolveRequiredCheckNames("acme/repo", {
				token: "tok",
				fetchImpl,
			}),
		).toBeNull();
	});
});

describe("resolveTransport (#3497)", () => {
	it("stays on gh when ghExec is not the module default, regardless of token or probe", () => {
		expect(resolveTransport(false, "tok", () => false)).toBe(TRANSPORT_GH);
	});

	it("stays on gh when the default ghExec is used but no token is set", () => {
		expect(resolveTransport(true, null, () => false)).toBe(TRANSPORT_GH);
	});

	it("stays on gh when the default ghExec is used, a token is set, and gh IS available", () => {
		expect(resolveTransport(true, "tok", () => true)).toBe(TRANSPORT_GH);
	});

	it("switches to REST only when the default ghExec is used, a token is set, and gh is confirmed missing", () => {
		expect(resolveTransport(true, "tok", () => false)).toBe(TRANSPORT_REST);
	});

	// Mutation table (each direction of the AND, per this batch's brief):
	// M1 ghExec-is-default flipped false -> must stay gh (proven above).
	// M2 token flipped absent -> must stay gh (proven above).
	// M3 probe flipped true (gh available) -> must stay gh (proven above).
	// M4 all three conditions hold -> must switch to REST (proven above).
	// A neutered guard (`return TRANSPORT_REST` unconditionally) is proven
	// by the PR body's mutation transcript, not restated here.
});

describe("run() — REST transport end to end (#3497)", () => {
	// PATH is genuinely emptied for the probe's real `gh(["--version"])`
	// call, so this reproduces "gh not on PATH" deterministically regardless
	// of whether the CI runner (which DOES carry `gh`, unlike this repo's own
	// sandbox) has it installed. `ghExec` is left at its real default -- not
	// overridden -- which is what makes `resolveTransport`'s
	// `usesDefaultGhExec` check true here, exactly as it is for a real
	// `node scripts/ci-verdict.mjs <target>` invocation.
	async function withEmptyPathAndToken(run_: () => Promise<void>) {
		const originalPath = process.env.PATH;
		const originalGhToken = process.env.GH_TOKEN;
		const originalGithubToken = process.env.GITHUB_TOKEN;
		process.env.PATH = "";
		process.env.GH_TOKEN = "test-token";
		delete process.env.GITHUB_TOKEN;
		try {
			await run_();
		} finally {
			process.env.PATH = originalPath;
			if (originalGhToken === undefined) delete process.env.GH_TOKEN;
			else process.env.GH_TOKEN = originalGhToken;
			if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN;
			else process.env.GITHUB_TOKEN = originalGithubToken;
		}
	}

	it("uses the REST transport, reaches the same verdict a green gh read would, and names the transport", async () => {
		const gitExec = (bin: string, args: string[]) => {
			expect(bin).toBe("git");
			expect(args).toEqual(["remote", "get-url", "origin"]);
			return "https://github.com/acme/repo.git\n";
		};
		const fetchImpl = async (url: string) => {
			if (url.includes("/pulls/2539")) {
				return new Response(
					JSON.stringify({
						head: { sha: "c0ffee" },
						mergeable: true,
						mergeable_state: "clean",
					}),
				);
			}
			if (url.includes("/branches/master/protection")) {
				return new Response("", { status: 403 });
			}
			return new Response(
				JSON.stringify({
					total_count: 2,
					check_runs: [
						checkRun({ name: "Unit tests", id: 1 }),
						checkRun({ name: "Lint & type-check", id: 2 }),
					],
				}),
			);
		};
		const stdoutLines: string[] = [];
		let exitCode: number | undefined;
		await withEmptyPathAndToken(async () => {
			exitCode = await run({
				argv: ["2539"],
				gitExec,
				fetchImpl,
				stdout: (line: string) => stdoutLines.push(line),
				stderr: () => {},
			});
		});
		expect(exitCode).toBe(EXIT_SUCCESS);
		expect(stdoutLines).toContain("Transport: rest");
		expect(stdoutLines.join("\n")).toContain("acme/repo@c0ffee");
	});

	it("still exits 70 when gh is missing and NO token is set (unchanged acceptance case)", async () => {
		const originalPath = process.env.PATH;
		const originalGhToken = process.env.GH_TOKEN;
		const originalGithubToken = process.env.GITHUB_TOKEN;
		process.env.PATH = "";
		delete process.env.GH_TOKEN;
		delete process.env.GITHUB_TOKEN;
		let exitCode: number | undefined;
		try {
			exitCode = await run({
				argv: ["2539"],
				stdout: () => {},
				stderr: () => {},
			});
		} finally {
			process.env.PATH = originalPath;
			if (originalGhToken === undefined) delete process.env.GH_TOKEN;
			else process.env.GH_TOKEN = originalGhToken;
			if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN;
			else process.env.GITHUB_TOKEN = originalGithubToken;
		}
		expect(exitCode).toBe(EXIT_TRANSPORT);
	});
});

// Sanity: MIN_GH_TIMEOUT_MS is re-imported here (used nowhere else in this
// file) purely so a future accidental removal of the export from
// ci-verdict.mjs breaks this file's import too, not just the owned suite.
describe("shared exports stay importable", () => {
	it("MIN_GH_TIMEOUT_MS is a small positive number", () => {
		expect(MIN_GH_TIMEOUT_MS).toBeGreaterThan(0);
		expect(MIN_GH_TIMEOUT_MS).toBeLessThan(60_000);
	});
});
