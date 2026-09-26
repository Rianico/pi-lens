---
section: Changed
---

- **Mutation diff now mutates product code, not just scripts (closes #3531)** —
  `scripts/stryker-diff.mjs` previously mutated only `scripts/**/*.mjs`, so
  every PR that touched `clients/`, `tools/`, `mcp/`, or `index.ts` printed
  "no changed scripts/**/*.mjs files" and the advisory `Mutation diff` workflow
  went green having mutated nothing. It now also mutates those sources through
  their compiled `.js` (what the test suite actually executes), mapping the
  PR's `.ts` diff hunks onto the compiled output via tsc source maps and
  reporting survivors back at `.ts` file:line. The workflow posts a job
  summary and a sticky PR comment listing every survivor (mutator, original →
  replacement) and the killed/survived/timeout/no-coverage counts; a run that
  evaluates 0 mutants always says why and never reads as a clean pass. A new
  `scripts/mutation-report.mjs` renders a downloaded `mutation.json` the same
  way for local use. The fixer and reviewer playbooks now read the PR's
  Stryker report before hand-mutating anything it already covers. Still
  advisory.
