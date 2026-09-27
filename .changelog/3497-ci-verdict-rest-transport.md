---
section: Changed
---

- `scripts/ci-verdict.mjs` now reads CI checks over the GitHub REST API directly when the `gh` CLI is not on PATH but `GH_TOKEN`/`GITHUB_TOKEN` is set — the Claude Code cloud container's own shape. It reads the same PR head/mergeable, check-runs, and required-check-name data `gh api` would, and the printed verdict now names which transport produced it (`Transport: gh` or `Transport: rest`). With neither `gh` nor a token it still exits 70, unchanged (closes #3497).
