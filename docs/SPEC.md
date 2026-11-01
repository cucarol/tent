# Tent Specification

This is Tent's public contract: what Tent does, as seen through its files, CLI and hooks. The rules live in `src/core/`; the CLI and the plugin packages stay thin. Retired commands and fields are removed, not aliased. How a rule is implemented, such as caches, indexes and the files inside `.tent/.git`, is documented in the code beside it.

The sections after the first follow the question each group of mechanisms answers: how things are kept, what a Node covers, what changed, what the Agent is told, what a reader gets, how a project is mapped, how work is handed over, and the rest.

## 1. Purpose and workspace

Node, Role and Card are the only concepts. A Node keeps one reusable fact, a Role keeps a direction of work, and a Card hands one input to a Role. Normal work, answers, code edits, review and Git stay in the host conversation and the user's tools; ordinary tasks need no Role or Card. Tent has no managed Agent, session registry, task scheduler or background service.

A workspace is the directory that contains `.tent/`. Its `workspaceId` in `.tent/settings.json` survives relocation; a missing or corrupt identity fails explicitly. Discovery walks up from the current directory and stops at a Git checkout boundary. From a linked worktree it follows the `.git` pointer to the main checkout's `.tent/`, so Node edits made in a worktree land in the main checkout and materials are read from the main checkout. Submodules, nested clones and bare repositories do not inherit a parent workspace. `--workspace` overrides discovery.

`tent new <workspace>` publishes an empty `.tent/` with its own history. It never replaces an existing `.tent/`, edits project files or creates Nodes. It writes `.tent/.gitignore` containing `*`, so Git ignores the whole Tent without any change under the project's `.git`. Deleting `.tent/` leaves the project working: builds, tests and project documents never depend on it. Project instructions stay in the project's own files, such as `AGENTS.md`.

## 2. Keeping things

### Nodes

A Node is a directory holding `<name>/<name>.md`. A directory without that file is a plain grouping folder. Placement gives the parent and child tree; the `node-…` id is the stable handle across moves and renames. The file name is the display name; a `title` field, if present, is kept aligned with it. Names must be valid Windows file names on every platform: `< > : " / \ | ? *`, a trailing dot, C0 control characters (U+0000–U+001F), DEL (U+007F), U+2028, U+2029 and the reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, `COM¹`–`COM³` and `LPT¹`–`LPT³`, with or without an extension) are rejected, and surrounding whitespace is trimmed.

`type` is exactly `goal`, `prompt` or `output`; any other value makes the document an invalid Node, in retained versions too. A goal is something that should become true, a prompt holds rules and context to follow, and an output records a result at one moment. Form and topic go in `tags`: free text without path separators or line breaks, any number, no behavior. Tent suggests ten presets: `direction`, `requirement`, `decision`, `spec`, `reference`, `procedure`, `asset`, `evidence`, `analysis` and `issue`. `node tags` lists the tags in use with their counts. Unknown YAML fields survive every edit. Invalid identity or type data and duplicate ids are reported, never silently repaired.

Record what will help later work: confirmed goals and constraints, decisions with their reasons, reference pointers, observed findings and facts about real results. A goal can exist before the work; a result that did not happen cannot be recorded. Goals and prompts hold settled intent, not commit ids, test counts or delivery status; dated evidence goes in an output. Agents do not write drafts: an undecided matter is asked in conversation or sent as a Card to the Role that decides it, and the settled result is recorded.

`status` is `stable` or `deprecated` (OKF v0.2 §5.4); omitted means stable, and Tent never changes it on its own. OKF's `draft` counts as stable. An unknown value is kept and reported, and that Node supplies no rules or coverage until it is fixed. Status belongs to one Node: the children of a deprecated Node keep their own. A deprecated Node stays readable and editable but drops out of resource lookup, rules and coverage. `node archive <id>` marks a subtree deprecated in one event; to bring a Node back, set its `status` again. `node delete` removes a subtree; it leaves materials and inbound links alone.

### Reading and writing

CLI reads are bounded for Agents. A page fits 16 KiB of compact JSON; longer text continues by range, and cut values are marked. `node get <id>` returns body text, ordered materials and an ETag; `--full` returns the whole body and `--view raw` the whole document with frontmatter; `--context` adds a summary of related Nodes and Cards of at most 1 KiB. `node list` shows children; `--type` and repeated `--tag` select from a whole subtree. `node read-many` reads several Nodes in one page. `node search --resource <path>` returns the current Nodes whose materials name or cover a Workspace file, most specific first, from headers alone. `node relations` lists links, mentions and material references in either direction. Reads never record history, move a basis or collect native edits; `node relations` and `--context` read the last collected documents, so a native edit shows there only after it is collected. A Node whose file differs from its retained version is marked `uncaptured`. Text search belongs to the Agent's own tools.

A write that replaces content presents the ETag of a complete read. The ETag of a partial read is marked `read:` and is rejected for replacement; a stale ETag is rejected, never refreshed. `node write` patches the body, the frontmatter or both, and omitted fields survive. `node append` adds to the end of the body, or of a named section, creating that section when absent, without a prior read; concurrent appends never overwrite each other. `node create` saves body, materials and tags together; `--id` fixes the new id, so a retry cannot create a duplicate. `node write-many --input-json` saves ordered creates and updates in one event, all or nothing; `@ref` names a Node created in the same batch in parents, links and material paths. Receipts carry each saved id, path and ETag, name the workspace root, and a failure ends with one copyable `Next: tent …` line.

`node write-many --draft <file>` consumes a scan draft (§7). It saves only the entries whose body is written: it first fixes their ids in the draft, saves them, then removes them from the draft and points the remaining references at the new ids. An entry whose parent still has an empty body stops the batch and names that parent. Running the same command after an interruption creates the missing ids and skips those already saved, so it never duplicates a Node or loses a body. Saving the last entry deletes the draft and its report.

Write receipts also give advice without changing anything stored. A goal or prompt that declares a local file Git does not track gets a hint to use an output, because Tent keeps no old bytes of that file to compare. A newly declared whole Markdown file with several sections gets a hint to cite the sections the Node depends on.

Node mutation receipts also list `problems` for the Node documents that command actually wrote, using the same address, document and material checks as `workspace check`. They do not inspect unrelated Node bodies or judge ahead and behind. The findings are advisory: the write stays saved, and a failure to inspect it is reported as a problem of that Node rather than a failed write. A receipt lists every problem in full; its read-back text is paged to keep the receipt within 16 KiB, but problems alone can take it past that.

### Native edits

Agents read Node files with their own reader and edit them with their own tools; creation, material declarations, confirmation and Card operations go through the CLI. Before any Node, Role or Card write, and in `workspace brief`, `check`, `drift`, `export` and SessionStart, Tent compares the Node files with their latest retained versions and records valid changes byte for byte. A new Node file written by hand is not recorded; `workspace check` lists it. Invalid frontmatter is left untouched, not recorded, and listed by `workspace check`. Each of these points keeps the bytes it sees, so intermediate edits between two points are not recoverable. Pure reads and the per-tool and per-turn hooks do not collect edits.

### History

Each save records the exact bytes of the changed Node, Role and Card documents as one immutable event in `.tent/.git/history.sqlite`; the project's own Git is never written. An event has an opaque 64-hex id, a time, an operation name and the ids it touched. A version `{commit, path}` names one document in one event; `node get --version-json` reads it after later edits, moves or deletion, and `node history <id>` pages a Node's versions across moves. An edit and its revert are two events, so a change since a version stays a change after a revert. Diffs are line diffs with three lines of context. A save that changes nothing creates no event. A Node's `contentChangedAt` is the time of the last event that changed its body or material addresses; moves, confirmation, tags and status do not count. When history cannot show that, or the file has uncollected changes, it is null rather than guessed.

### Safe writes and recovery

Tent writers share one on-disk mutation lock. A CLI write waits briefly for a busy lock, then names the lock it could not take; a live process is never evicted for age alone. Before changing files, a write records the exact before and after bytes of every affected file in a transaction journal. Files and the history database are not one transaction: the next Tent command settles an interrupted write to all old or all new before it reads anything. Bytes matching neither are external edits; they are kept and reported, and recovery never deletes unexpected content. Process termination is covered; what survives a power loss depends on the filesystem.

Damaged or unsupported history fails explicitly. Workspaces still on the old private-Git history are not read; `migrate-history.mjs` converts an offline copy once, as [MIGRATION.md](MIGRATION.md) describes.

Caches under `.tent/.git/tent-material-cache/` only make reads faster: deleting them changes no result, and a missing or broken cache falls back to reading files. A cached file observation is reused only while the file's size, times and identity match and the file is older than one second, so an edit that keeps all of those can be missed; `node check` always reads content.

## 3. What a Node covers

`resource` names a Node's primary material; ordered `sources` list other related materials. A material is a local file, directory, file-name prefix or Markdown section, a Node, Role or Card document, or a remote URI, which Tent never fetches. Materials say what a Node rests on; they do not prove ownership or a complete impact set.

In stored documents, `./` and `../` resolve from the declaring file, a leading `/` resolves from `.tent`, and `file:` URIs are absolute; separators are `/`. At the CLI, new material paths start at the Workspace root and are stored document-relative. A trailing `/` marks a directory, and `./` declares a path that does not exist yet. A stored bare source is a description, whether or not a file of that name exists; only at the CLI does a bare path to an existing file become a file address. Ordinary files inside `.tent/` cannot be materials. `path.md#Heading` selects one Markdown section by its heading text: its version covers that heading through the next heading of the same or higher level, so edits elsewhere in the file do not count. A missing or duplicate heading makes the material unavailable.

A directory such as `src/api/`, or a file-name prefix such as `src/flask/views*`, declared with `track: structure` makes its Node a module that owns those files. Files Git ignores are left out. When several modules cover a file, the most specific one owns it; a parent module owns the files no child claims, new files included. A module's code dependencies are part of what it rests on (§4).

Markdown links, standard fields and bare `node-xxxxxx` tokens in a body relate Nodes to each other. Saves turn Node ids in links and materials into relative paths, and moves and renames rewrite the affected live links and materials, never historical Card input. A local body link must point to an existing file, or to an existing directory when it ends in `/`. `workspace check` reports unresolved links and missing materials.

## 4. What changed

### Bases

Saving a Node records a basis for each local material, kept outside the Markdown in the same history event as the document: a SHA-256 of the file or selected section, with text line endings normalized, and for a module's structure source the set of local dependencies its code imports. Only creation, a newly declared material, explicit confirmation and an output's first placement under a goal set a basis. Ordinary saves, metadata edits, native edits and reads keep the old one, and a material that could not be observed keeps an unknown basis rather than a guessed one. A basis record of an unsupported shape gives that Node no basis and leaves the others usable. Materials are read only at their declared live location, never from another checkout or from history.

A directory or prefix material without `track: structure` gives coverage only: it has no basis, so its members changing never makes anything behind. A structure source's basis is the set of outgoing local dependencies of its production files; test imports are left out. Targets inside the same Node's structure sources are internal and not recorded. External targets are grouped by directory, except that a non-member file beside the importing file is listed by its path. Incoming imports, membership and content edits count only when they change that outgoing set. The import extractor's languages and limits apply (§7); a relevant resolution failure, or a Go package only partly inside the module, makes the observation unavailable rather than partial.

Code edits under a module can make its prose wrong without changing its structure. The end-of-turn review (§5) asks about that; a rule that must follow particular content names that file or section as a material.

### Behind

A goal or prompt is behind when a material's current version differs from its basis, or a material it had is missing or unavailable. An output records one moment, so changes to its materials or its goals never make it behind.

A Node material compares by meaning: its body with normalized line endings, its ordered material addresses and their `track` modes. Type, tags, status, authorship and confirmation do not count, so confirming an upstream Node without changing what it says makes no one behind. A matching version proves only that the recorded bytes still match, not that the text is right.

### Ahead

Every goal is a requirement, and a goal is ahead while nothing carries out its current text:

- A goal that covers a directory or prefix, or has a current descendant goal that does, keeps its own intent basis, its body and declarations, from creation or confirmation. A single file, a Node or Role reference or a URL does not count as covering. While that basis matches, the goal is not ahead; changing the goal makes it ahead until it is confirmed or a current output matches it.
- Any other goal is ahead when no current output in its subtree has bases matching the goal's current body and all its materials. One output must match the whole goal; an output under a nested goal also satisfies its ancestors.

A goal can be ahead and behind at once; the two are reported separately.

### Outputs and confirmation

An output keeps comparison bases for its own materials and for every goal above it. A complete read of an output lists `changedSince`: its own materials whose version changed and, if it changed, the nearest goal above it. This is information only and never enters the behind list.

`node link-output <goal-id> --resource <address>` creates an output under a goal for an existing local file or directory, a Node or a URI; `--name`, `--tags` and `--card` are optional. A path under `.worktrees/` gets a warning to merge into the main checkout first. The goal itself does not change.

`node confirm <id> --base-etag <etag>`, after reading the complete Node and its materials, refreshes its bases, and a goal's intent basis, without changing the body, and records a verification. `node write --confirm`, or `confirm: true` in write JSON and batch updates, saves and confirms together. Both need the ETag of a complete read. Confirming a goal does not refresh the outputs under it; confirming an output clears its `changedSince`. An unavailable material stays unavailable after confirmation.

`node check <id>` reports ahead and behind with their reasons: each material's recorded and current version and, for a structure source, up to 20 added or deleted dependencies. It reads content directly and changes nothing.

### Verification

`verified: [{by, at}]` (OKF v0.2 §5.2) keeps the latest confirmation of each actor and survives later content edits. A confirmation accepts `--by` as `human:<id>`, `process:<id>` or `<producer>/<version>`; without it Tent records its own `tent/<version>`, never a guessed person or model. Times are ISO 8601 with an explicit zone. Tent neither writes nor checks `generated` or `stale_after`; like any other field, they survive edits untouched.

## 5. What the Agent is told

Tent speaks to the Agent at the start of a session, after a file write, after the user answers a question, and at the end of a turn. Each notice says what to do, and notices about changed files copy the Nodes that cover them; none proves that a Node is right, and the Agent maintains Nodes through the ordinary operations. When nothing needs recording, the Agent says nothing about it.

### Brief and drift

`workspace brief [--role <role>]` first collects native edits, then reports within 16 KiB: up to ten recently changed Nodes with their change times, up to ten of the Role's unfinished Cards in queue order (pending, returned results, work awaiting return), and up to ten workspace problems (invalid documents, ahead Nodes, changed Card sources, behind Nodes, uncertainty). Each row is one line of at most 120 code points; titles can be shortened, ids never are. Omitted rows are counted with the command that lists them. The Role filters Cards; Node and problem counts stay workspace-wide. Card delivery never proves a goal fulfilled, and a change time is a retained event, not proof of which session made it.

`workspace drift` pages the ahead and behind Nodes; each behind Node lists its materials with recorded and current versions and changed dependencies, and points to `node check <id>` when the list is too long for the page. Both commands read current material versions with or without hooks.

### Hooks

Both plugins register SessionStart, UserPromptSubmit, PostToolUse and Stop. Speed is held by acceptance guardrails, each the median of eleven alternating pairs of a hook run and a bare `node` start on each host: an ordinary tool hook adds at most 100 ms, loads no full CLI and starts no Git; on a repository of 7,570 files UserPromptSubmit adds at most 100 ms, and Stop at most 600 ms when few files changed and two seconds when all did. A write to a Node file refreshes the index through the full CLI under the workspace lock, a write to a linked Markdown section briefly locks that file's section record, and SessionStart can take longer when it prepares the index. Until the index is prepared for this workspace the hooks stay quiet; init, SessionStart and Tent's own graph writes prepare it, so Node edits made by shell or other tools reach it at the next SessionStart. No hook registers a session or reads a transcript.

**SessionStart** collects native Node edits, prepares the index of which Node covers which file and its governing rules, and records a fingerprint of every linked Markdown section. It gives only the workspace, CLI, build and this instruction, without running or suggesting a brief:

```text
Tent Workspace: <workspace>
Tent CLI: <command>
Build: <build>
Tent shows you the Nodes that cover each file you change, right after the change. No Tent command is needed before working.
```

**PostToolUse** speaks after a supported file tool succeeds with a reliable write path: Claude Code's Write, Edit, MultiEdit and NotebookEdit, and Codex `apply_patch` with its published paths. Reads, errors, shell commands, and writes under `.git`, `.scratch`, `node_modules` and `.venv` produce nothing. A written project file selects its most specific covering modules and every Node that links it as a material, whole or as a section that actually changed, and copies their current bodies, then the direct prompts of those Nodes and of every goal above them, nearest first; a Node reached twice is copied once:

```text
Tent: these Nodes cover the file you just changed.

<name> (<nodeId>, <path>) covers <files>:
<text>

Rules over it:
<name> (<nodeId>, <path>):
<text>

If one now says something the change made wrong, edit that sentence in its file. If the change settled a rule or a rejected option that also binds code it did not touch, or hit a dead end, add one short section: tent node append <nodeId> --heading <title> --body -. A lesson about these lines belongs in a code comment or a test. Otherwise say nothing about Tent.
```

A successful native write to a Node file inside `.tent/` checks that Node with the same rules as `workspace check`, without collecting edits, confirming it or checking unrelated Node bodies. If it has problems, it says:

```text
Tent: <path> has problems:
- <problem>
Fix them before you end this turn.
```

A clean Node produces no notice. Other writes inside `.tent/` produce no covering-Node notice; explicit graph writes still refresh the prepared index. CLI Node mutations return the same problems in their receipts, so the Agent does not run a separate `workspace check` after saving.

Hand-written product code that no module owns gets, once per session per file:

```text
Tent: no module Node owns these files: <paths>. Before you end this turn, add a directory or filename-prefix source with track: structure to the module Node that owns them, or create a module Node if they start a new area. If they are temporary, say nothing about them.
```

A question tool the user answered (Claude Code AskUserQuestion, Codex `request_user_input` or `request_user_input_async`) gets, unless the answer is empty or cancelled:

```text
Tent: the user just answered. If the answer settles a requirement or a decision, record it in the Node it belongs to before you end this turn; otherwise say nothing about it.
```

**UserPromptSubmit** records the time and HEAD at the start of the turn, without starting Git.

**Stop** finds the files that changed during the turn, including shell and external edits, from one `git status` and file times since the turn started, plus the committed paths if HEAD moved. Committing older changes stays quiet; a deletion counts only if the file was not dirty at the end of the previous turn, as recorded by the last Stop or SessionStart, and stays quiet without that record; ignored files and submodules never count; Git runs the repository's own filters as usual; and a write that preserves file times can be missed. Nodes already delivered during the turn are left out. If any remain, Stop asks the Agent to continue once, with the PostToolUse list under this header:

```text
Tent: these Nodes cover files changed during this turn.
```

A turn already continued by Stop, a turn with no start record and a workspace outside Git stay quiet.

A covering-Node notice is at most 8 KiB including its JSON envelope. Each Node's body is copied without summarizing, at most 1600 Unicode code points; a shorter excerpt ends with `… (cut; the rest is in <path>)`. Nodes that do not fit are counted as `<n> more Nodes: tent node search --resource <file>`. The first line and final action always remain; Node bodies take priority in selected order, then recovery lines in file order while they fit, with space reserved for the rest as `<n> more Nodes cover <m> other changed files: run tent node search --resource on each.`; recovery lines must not make the whole notice disappear. Only Nodes actually copied are marked as delivered, at most once per turn; a rule omitted after its owner was delivered can appear through another covering Node or in a later turn. A problem notice is held to the same 8 KiB: whole problems are listed in order while they fit, a first problem too long to fit is cut, and the rest are counted on a line before the last, `<n> more problems: tent workspace check --json`. Shell and external edits are seen only at Stop, never immediately.

## 6. What a reader gets

Ordinary code work needs no Tent read first: the Hooks copy the covering Nodes and their rules after a change (§5). When an Agent reads a Node or takes a Card, Tent hands it the related context from the graph. The first page of `card show`, `card take`, `node get` and `node search --resource` carries an `agentContext`, gathered from the Card's sources, the Node, or the Nodes whose materials cover the file. It has eight lists, each with at most ten entries and its complete total:

- `references`: the source body or selected section, copied, up to 1600 code points;
- `rules`: the goals whose materials cover those files, their direct prompts, and the goals above the Node or Card source being read, each with its first authored sentence;
- `paths`: the files those Nodes cover;
- `tests`: test files that statically import that code, each with the import that links it. A similar file name is no evidence, and an empty list means none were found, not that none exist;
- `changes`: for a pinned source, bounded line diffs from its pinned version to its latest retained one; for an output, the recorded bases that no longer match;
- `decisions`: Nodes and files the body links to or names, and Nodes that link to it;
- `open`: unfinished Cards whose sources are these Nodes, and the read goal or its direct child goals with no output below them, which shows only that none was recorded;
- `unknown`: what could not be determined, and why.

For file-start reads, `paths` and `tests` come only from the most specific covering structure modules and exact-file material Nodes, deduplicated before pagination; higher goals contribute rules without expanding their files.

Every assembled entry states the relationship that selected it. Text is copied, never summarized, and gathering it confirms, records and repairs nothing. The whole response fits 16 KiB, with the primary body taking at most half; when room runs out, later lists shrink to titles and then drop out, each marked, and ids and addresses are never shortened. The source commands it prints recover the bodies and a raw Card read every source address and version; no command lists every omitted entry. A Card source keeps its pinned version. `node-xxxxxx#Heading` or a link ending in `#Heading` selects one section of a source; a missing or duplicate heading becomes an unknown, and the source's pinned opening stands in for the section, never today's text. Tent keeps no old project-file bytes, so code changes since a basis show only as changed versions, and since it records no session boundary, what the last session did is unknown. Raw views, `--full`, continuation pages and `read-many` carry no `agentContext`.

## 7. Mapping a project

`workspace scan` reports the facts for planning modules from the current checkout: coverage, directory imports and cycles, generated directories, file-name groups and guidance files. It runs no model and writes nothing; a workspace that is not a Git checkout fails. Text output is a short overview with `+N more` counts; `--json` has every fact. Guidance files are the usual project documents (README, AGENTS, CLAUDE, CONTRIBUTING, ARCHITECTURE, DESIGN and the like, `.cursor/rules`) and Markdown or text under top-level `docs/` or `doc/`. `package.json` entry points and Claude Code and Codex plugin manifests mark product boundaries even where there is no parseable code.

`workspace scan --draft <file>` writes an editable module map in the `node write-many` format, plus a JSON Lines report beside it whose name ends `.report.json`. It needs a Workspace with no Nodes and refuses to overwrite either file. Each proposed part is a goal with an empty body that owns its directory or file-name prefix through a structure source; real directory layers become parents and children. Leaf parts aim at ten code files or fewer, tests excluded: large directories split along subdirectories, flat directories by load-time imports, then by file-name stems. Only `module-load` imports group files. Generated files stay with their source, tests beside code stay with it, a separate test tree becomes a plain Tests part, a root code file joins the one part it shares the most load-time imports with while that part is under the size target, and otherwise becomes its own part flagged for review, root tests go to Tests, other root files go to Setup, and each top-level `docs/` tree becomes one Docs part. The Agent names the parts, adjusts their boundaries, writes their bodies and adds the project's own goal beside them. The report has one line per part, findable by searching `"ref":"@<ref>"`, with its files, tests, co-changing parts, history and findings. The printed receipt fits 4 KiB. Exit 1 means there are findings to settle; imports Tent could not resolve are reported without changing it, and both files are written either way.

`workspace check-modules [--json]` checks a module map against the same import facts and the latest 300 first-parent commits, without writing anything. Each finding names a rule, the modules and one suggested fix; JSON also lists each module's files, `testedBy` (test files importing its code) and `coChanges` (modules changed in the same commits, with counts). Exit 0 means the map is clean; imports Tent could not resolve are reported without changing the exit code. The rules:

- `map.uncovered`: tracked files no Node covers;
- `map.unowned`: covered production code no module owns;
- `module.oversized` and `module.skewed`: a leaf module with at least 20 production code files (tests, generated and vendored files do not count) that holds more than 20% of the project's, or more than three times the median of its other non-empty siblings, and has at least two groups of three or more files that could split;
- `deps.cycle`: two modules, neither inside the other, load each other, with at least three imports in the smaller direction and at least 10% of the larger, not counting tests or `index` barrel files;
- `history.always-together`: two modules share at least five commits, at least 90% of the less-changed one's, with lift of at least two; commits touching more than 50 files are left out;
- `history.generated-apart`: the same, where one module is mostly generated files.

A module keeps an intended exception with a line `allow:<rule>` in its body or in a prompt under it, short of any nested module; a pair rule also needs a link to the other module on that line. The two `map.` rules cannot be excepted.

Imports are read from TypeScript, JavaScript, Python, Go, Rust, Java, C#, C, C++ and PHP source as written, without running code, compilers or build tools. Each import is classed as `module-load` (loads when the file loads), `deferred` (inside a function), `type-only` or `compile-time` (Rust, Java, C#, C/C++ and PHP name dependencies). A name the extractor cannot resolve to one local target is reported, never guessed; a PHP include that depends on the runtime include path links each existing candidate, marked uncertain. What each language's extractor follows, and where it stops, is documented with its code and tests.

`workspace check` reports broken links, invalid or missing materials, missing sections, and Node files that disagree with retained history (`node-git-mismatch`), and lists documents it could not inspect. It exits 1 when there is anything to report. It checks that things exist, not whether they are still right; that is `node check`.

## 8. Handing work over

### Roles

A Role is one document at `roles/<role-id>.md` with `type: role`, an id and an optional title. It holds a direction of work, its boundaries, its way of working and links to Nodes; shared facts stay in Nodes. Selecting a Role is explicit: reading it binds no session, claims nothing and repairs nothing, and a new conversation can read the same Role to pick up its direction. `role create`, `role show`, `role write --base-etag` and `role list` (deprecated Roles only with `--include-deprecated`) follow the ordinary read and write rules. `role delete --base-etag` removes the document for good; its id is never reused. Deleting a Role, or marking it deprecated, is refused while a Card still waits on it: pending for it, to be returned to it, or received by it and not yet returned. The refusal lists those Cards.

### Cards

A Card is one document at `cards/<card-id>.md` with an optional title, ordered `sources`, an optional `target` Role, an optional `returnTo` Role and a prompt as its body. Creation publishes it at once; there are no Card drafts. Each Node or Role source is pinned to the version current at creation, so the receiver reads exactly what the sender saw and can compare it with the current version. A source can select one section as `node-xxxxxx#Heading`; `card create` warns when that heading is missing. External addresses are neither fetched nor pinned. `card create` warns on stderr, without changing what it stores, when an explicit path source (starting `./`, `/` or `.tent/`) names nothing that exists. A Card records no sender. Body, title, sources and `returnTo` never change after publication; a hand edit is readable but blocks taking and returning with `INPUT_CHANGED`. Requirements that change belong in Nodes.

A Card is `pending`, then `consumed` when it is taken: by its target Role, or, for a public Card with no `returnTo`, by any session without a Role. With `returnTo` it goes on to `returned` when the receiver returns a result, and to `closed` when the `returnTo` Role takes that result. Without `returnTo`, consumed means complete; with it, returned means complete and closed means the result was collected. `card take <id> --role <role>` receives a pending Card, or collects a returned one, under the mutation lock; repeating the same take is a replay that grants no second execution. `card return <id> --role <role> --result <text>` records a result of one line and at most 200 characters; details go in Nodes, whose ids may appear in it. Returning the same text again is a replay; different text is rejected. A Card shows delivery state only: no progress, goal counts or output lists are derived from it, and goal and output findings never retract a return.

Each Role has an ordered queue of pending Cards, oldest first by default; the public area holds untargeted Cards and is shown only on request. `card move <id> [--to <role> | --public] [--before <id> | --after <id>] --base-etag <etag>` reorders a pending Card or sends it to another Role, writing only that Card. `card deprecate <id> --base-etag <etag>` cancels a Card, even after it was taken, keeping what was received; lists and brief leave deprecated Cards out unless asked, and an explicit `show` or `take` still works and warns. `card list` filters by Role and state. `card watch --role <role> [--include-open] [--timeout <seconds>]` waits until a pending Card for that Role, or a result returned to it, exists, then prints one line per Card: the command to take a pending Card, or the result of a returned Card; it exits 0 with input, 2 on timeout and 1 on error, and receives nothing itself. Taking a public Card claims it; of two concurrent claims one wins and the other is told who.

While a Card is in progress, brief lists its pinned source goals that changed since pinning and are still ahead, so the receiver rereads them. `node link-output --card <id>` records an output as the response to a Card that is taken and not yet returned, whose pinned goal lies on the output's goal chain; with `--role` alone, Tent picks the one in-progress Card that fits, and asks for `--card` when several do.

## 9. Everything else

### Plugins and Skills

One build makes the Codex and Claude Code packages from the same CLI, four Skills, references and this specification; each host gets a thin shell for its manifest, hook definitions and launcher. `tent-init` creates a Tent and maps a project, `tent-node` reads and maintains Nodes, `tent-role` takes on or keeps a Role, and `tent-card` sends and receives Cards. Command details live in references read on demand, and apart from mapping a project, no Skill asks for a fixed reading order, and none asks for a per-turn Node count or a full-tree pass. The plugin runs from its installed path, keeps no graph data in the plugin cache, installs no global hook copies and configures no MCP server. Building, installing, trusting the hooks and real event delivery are separate checks; a package being present proves none of the others.

### Build identity

`tent --version` prints the version, commit and build time; `tent version --json` returns `version`, `commit`, `builtAt`, `dirty` and `runtimePath`. A built CLI carries its identity wherever it is installed. This is local provenance, not an update check.

### Export

`tent workspace export --output <new-directory>` copies the whole graph, with its history, Roles, Cards and other retained files, to a new directory under the Workspace's `output/` or `.scratch/` and verifies the copy against the source. Tent's own locks, temporary files and caches are left out; any other file under `.tent/` is copied as it is. Materials outside `.tent/` are not copied: the export lists them in `externalNotPacked`, and bare or invalid ones in `unresolvedMaterials`. A pending write, invalid history or a missing local material referenced inside `.tent/` stops the export. Like other commands it first collects native edits; the copy itself never changes the source.
