# One-shot history migration

Tent stores Markdown on disk and immutable event history in `.tent/.git/history.sqlite`. The operational `.git` directory contains no private Git history repository or runtime fallback. Its `ignore-context/.git` subtree is an empty unborn tool context for the existing Git ignore interpreter, created only during workspace initialization or migration setup; it has no commits and never stores document history. Missing Git leaves ignore-dependent observations explicitly unknown while SQLite initialization and document CRUD remain available. Fixed versions retain `{commit,path}`; `commit` is now a 64-hex opaque event identity.

Stop all writers and work on a complete offline workspace copy, including its current `.tent` files and private Git objects. Preserve dirty files and unretained Nodes: a Git archive of HEAD alone is not a copy of the current workspace. Keep project material files in that copy so their relative addresses remain meaningful.

Use the bundled migration utility with an unused target:

```sh
node migrate-history.mjs --source /offline-copy/.tent --output /staged-conversion/.tent --report /migration-audit.json
```

In a source checkout, the equivalent development entry is `node --import tsx src/cli/migrate-history.ts ...`. The ordinary CLI never performs automatic migration. The utility never edits the source, replaces an existing target or activates the result. It also refuses an existing audit output.

The audit must establish all of the following before a converted `.tent` is published in the copied workspace:

- Every recognized Node, Role, Card and output fixed source maps to a published event and resolves the original historical document, including sources inside other historical documents.
- Only the exact version hexadecimal scalar changes from the old address to its mapped event ID. Surrounding YAML style, comments, Markdown, line endings, unknown metadata and ordinary text containing the old ID remain unchanged.
- Each historical/current document records original SHA-256, expected converted SHA-256 and actual imported SHA-256. The last two match. Every replacement records the field and exact original byte range. Unchanged documents match their original bytes directly.
- Original historical bytes remain in audit tables. The old-to-new event lookup is an external report, not a runtime alias table. Runtime readers reject old 40-hex addresses.
- Each pinned target is checked with Core's Node/Role identity validator before and after conversion. Valid targets have `verified: true`. An already-invalid historical target is preserved, not repaired or rejected for its identity error: its original and imported Core diagnostics must match. Such pins have `verified: false`, `status: originally-invalid-preserved` (原本无效，原样保留), and are listed separately in `preservedInvalidPins`. Matching bytes and preserved diagnostics do not make that target valid.
- Dirty, deleted and unretained current documents are listed separately from retained history. Binary ordinary files and empty directories are preserved. SQLite passes integrity_check.

The importer accepts a linear, single-parent history (including an unborn empty workspace). It rejects merges, additional history roots, unmapped events, malformed fixed addresses or resource/version disagreements, missing historical objects, unsupported pinned YAML aliases, symbolic links and unsettled file operations. These address/object failures are distinct from an existing historical target identity diagnostic. It never silently substitutes a current file for a historical target. An unsupported source, changed source or changed target diagnostic stops the import; any incomplete fresh target is diagnostic data, not an active workspace. Review the error and source evidence rather than rerunning into that same target.

Fixed-source resource validation covers document-relative and bundle-root addresses. The utility conservatively rejects absolute `file:` source pins whose original-root identity cannot be established in this offline namespace. It does not rewrite resource addresses or guess an original workspace root. This is a limit of the migration utility; ordinary runtime material reads retain their existing `file:` behavior.

After auditing, an operator may place the converted graph in the copied workspace and validate it through normal reads. Retain the original copy and external audit until that validation and independent review are complete. Switching a live workspace is a separate explicit action.

SQLite uses DELETE rollback journals with synchronous EXTRA. Markdown and the database remain separate resources joined by Core's durable file journal and mutation lock. Process-termination checks validate recovery boundaries; they do not establish physical power-loss behavior. The minimum runtime is Node 22.19.0, and CI covers that minimum and the current Node LTS on Windows, macOS and Linux.
