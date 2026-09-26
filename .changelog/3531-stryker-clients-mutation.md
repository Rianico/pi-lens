---
section: Changed
---

- **Mutation diff now mutates product code, not just scripts (closes #3531)** —
  `scripts/stryker-diff.mjs` previously mutated only `scripts/**/*.mjs`, so
  every PR that touched `clients/`, `tools/`, `mcp/`, or `index.ts` printed
  "no changed scripts/**/*.mjs files" and the advisory `Mutation diff` workflow
  went green having mutated nothing. It now also mutates those sources through
  their compiled `.js` (what the test suite actually executes), mapping the
  PR's `.ts` diff hunks onto the compiled output via tsc source maps
  (column-aware, so a survivor on a collapsed multi-line expression reports
  its real `.ts` line) and reporting survivors back at `.ts` file:line. The
  range budget is sized from a measured `--dryRunOnly` cost
  (`budget × concurrency ÷ dry-run seconds`) rather than a fixed range count,
  with a deterministic, seeded sample when the diff still exceeds it; a
  budget kill reports the partial result Stryker itself saved, labelled
  `Partial run`, instead of a bare "no mutants evaluated". The workflow posts
  a job summary and a sticky PR comment (matched to the bot's own prior
  comment, never a human's) listing every survivor (mutator, original →
  replacement) and the killed/survived/timeout/no-coverage counts; a run that
  evaluates 0 or partial mutants always says why and never reads as a clean
  pass, and a head whose job produced no report at all marks its PR comment
  stale rather than leaving an earlier head's report up unmarked. A new
  `scripts/mutation-report.mjs` renders a downloaded `mutation.json` the same
  way for local use. The fixer and reviewer playbooks read the PR's Stryker
  report (once one exists) before hand-mutating anything it already covers,
  including a partial run's unevaluated remainder. Still advisory.
