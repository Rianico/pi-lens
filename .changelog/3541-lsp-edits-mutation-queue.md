---
section: Fixed
---

- **pi-lens' language-server edits no longer erase an edit the agent makes to the same file at the same time (closes #3541)** — the end-of-run quick fixes for actionable warnings, `lsp_navigation`'s applied `rename` and `rename_file`, and edits a language server sends while it runs a command read each file, changed it and wrote it back without taking a turn in pi's queue for the file. An agent `edit` or `write` that landed in between was overwritten. These edits now take their turn in pi's queue for every file they touch, in one fixed order so two of them cannot wait on each other, and check that the files still match what the edit expects inside that turn. `cargo clippy --fix` and `dart fix` can still change files other than the one pi-lens fixes without a turn for them; that is tracked in #3598.
