/**
 * #3763 item 5 / #3824 S2 — the mutation bridge's epoch/lineage population.
 *
 * The bridge accepts a foreign `readGuardBranchEpoch` on an entry and resolves
 * it against the live read guard. A well-formed value ABOVE the live epoch is
 * ignored and recorded (never silently skipped), and the entry is then
 * fail-open: it is credited and queued at the current epoch. That direction is
 * safe only because a producer that can name an epoch also captured the
 * lineage that answers currency (the in-process settled sweep). The bridge
 * exposes no epoch to read, so a producer without a lineage cannot learn one;
 * a no-lineage entry carrying an epoch is therefore an invented value.
 *
 * This sweep pins that population: every call site that writes
 * `readGuardBranchEpoch` into the bridge must also write `lineage`. A future
 * producer that sends an epoch without a lineage reds here, at the construction
 * site, before it can reach the fail-open branch. The behavioural half — that
 * the one real producer's entry carries both — is pinned in
 * `tests/index-observed-sweep-no-read-guard.test.ts`.
 *
 * Known limit, stated rather than papered over: the census reads the object
 * literal at the call site. A producer that forwards an epoch through a
 * spread (`{ ...entry, lineage }`) is invisible here; the runtime pin above is
 * the behavioural check for the producers that exist today.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	callSites,
	listSourceFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

/** Bridge-entry construction sites under the production source roots. */
function bridgeEntryCallSites(): Array<{
	file: string;
	line: number;
	argsText: string;
}> {
	const files = ["clients", "tools"].flatMap((root) =>
		listSourceFiles(path.join(REPO_ROOT, root), { skipTests: true }),
	);
	files.push(path.join(REPO_ROOT, "index.ts"));
	const sites: Array<{ file: string; line: number; argsText: string }> = [];
	for (const file of files) {
		const source = fs.readFileSync(file, "utf8");
		for (const site of callSites(
			source,
			/^(recordMutation|replayThroughMutationBridge)$/,
		)) {
			sites.push({
				file: relativePosix(REPO_ROOT, file),
				line: site.line,
				argsText: site.argsText,
			});
		}
	}
	return sites;
}

describe("#3824 S2: a bridge entry names its lineage whenever it names an epoch", () => {
	it("every readGuardBranchEpoch construction site also constructs lineage", () => {
		const sites = bridgeEntryCallSites();
		assertNonEmptyScan("bridge entry construction sites", sites.length, 1);
		const epochSites = sites.filter((site) =>
			stripSource(site.argsText, { strings: "blank" }).includes(
				"readGuardBranchEpoch",
			),
		);
		// Floor: the one real epoch sender (the settled sweep) is in the census,
		// so a dead scan or a moved producer cannot read as clean.
		assertNonEmptyScan("epoch-carrying bridge entries", epochSites.length, 1);
		const withoutLineage = epochSites
			.filter(
				(site) =>
					!stripSource(site.argsText, { strings: "blank" }).includes("lineage"),
			)
			.map((site) => `${site.file}:${site.line}`);
		expect(withoutLineage).toEqual([]);
	});
});
