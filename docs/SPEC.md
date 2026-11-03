# Tent Specification

This is Tent's public contract: what Tent does, as seen through its files, CLI and hooks. The rules live in `src/core/`; the CLI and the plugin packages stay thin. Retired commands and fields are removed, not aliased. How a rule is implemented, such as caches, indexes and the files inside `.tent/.git`, is documented in the code beside it.

The sections after the first follow the question each group of mechanisms answers: how things are kept, what a Node covers, how results are recorded, what the Agent is told, what a reader gets, how a project is mapped, how work is handed over, and the rest.

## 1. Purpose and workspace

Node, Role and Card are the only concepts. A Node keeps one reusable fact, a Role keeps a direction of work, and a Card hands one input to a Role. Normal work, answers, code edits, review and Git stay in the host conversation and the user's tools; ordinary tasks need no Role or Card. Tent has no managed Agent, session registry, task scheduler or background service.

A workspace is a directory inside a Git repository that contains `.tent/`. Git is required. Its `workspaceId` in `.tent/settings.json` survives relocation; a missing or corrupt identity fails explicitly. Discovery walks up from the current directory and stops at a Git checkout boundary. From a linked worktree it follows the `.git` pointer to the main checkout's `.tent/`, so Node edits land in the main checkout. Ordinary material reads use the main checkout; Stop compares the originating checkout and matches coverage by its workspace-relative paths (§5). Submodules, nested clones and bare repositories do not inherit a parent workspace. `--workspace` overrides discovery.

`tent new <workspace>` first runs `git init` in that directory if it is not already inside a Git repository, then publishes an empty `.tent/` with its own history. An existing repository or linked worktree is left unchanged. When initialization is needed, it prints `Initialized a Git repository in <root>` before `Created Tent`, with the actual root path. If Git cannot be found, it fails with `Tent needs Git; install Git, then run tent new <root>`. It never replaces an existing `.tent/`, edits project files or creates Nodes. It writes `.tent/.gitignore` containing `*`, so Git ignores the whole Tent without changing the project's Git exclude configuration. Deleting `.tent/` leaves the project working: builds, tests and project documents never depend on it. Project instructions stay in the project's own files, such as `AGENTS.md`.

## 2. Keeping things

### Nodes

A Node is a directory holding `<name>/<name>.md`. A directory without that file is a plain grouping folder. Placement gives the parent and child tree; the `node-…` id is the stable handle across moves and renames. The file name is the display name; a `title` field, if present, is kept aligned with it. Names must be valid Windows file names on every platform: `< > : " / \ | ? *`, a trailing dot, C0 control characters (U+0000–U+001F), DEL (U+007F), U+2028, U+2029 and the reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, `COM¹`–`COM³` and `LPT¹`–`LPT³`, with or without an extension) are rejected, and surrounding whitespace is trimmed.

`type` is required and is exactly `goal`, `prompt` or `output`; any other value makes the document an invalid Node, in retained versions too. These are names: Tent gives them the same coverage, reading and writing behavior. `description` is an optional one-sentence string; a non-string value is a document problem reported by `workspace check`. Form and topic go in `tags`: free text without path separators or line breaks, any number, no behavior. Tent suggests ten presets: `direction`, `requirement`, `decision`, `spec`, `reference`, `procedure`, `asset`, `evidence`, `analysis` and `issue`. Unknown YAML fields survive every edit. Invalid identity or type data and duplicate ids are reported, never silently repaired.

`verified` is a retired Node field, reported by `workspace check`; it does not confirm a Node or change coverage. The one-off [metadata cleanup](MIGRATION.md#remove-retired-node-metadata) removes it together with retired source tracking fields.

Record what will help later work: confirmed goals and constraints, decisions with their reasons, reference pointers, observed findings and facts about real results. A result that did not happen cannot be recorded. An undecided matter is asked in conversation or sent as a Card to the Role that decides it, and the settled result is recorded.

`status` is `stable` or `deprecated` (OKF v0.2 §5.4); omitted means stable, and Tent never changes it on its own. OKF's `draft` counts as stable. An unknown value is kept and reported, and that Node supplies no coverage until it is fixed. Status belongs to one Node: the children of a deprecated Node keep their own. A deprecated Node stays readable and editable but drops out of current coverage. `node archive <id>` marks a subtree deprecated in one event; to bring a Node back, set its `status` again. `node delete` removes a subtree; it leaves materials and inbound links alone.

### Reading and writing

Agents find, read and edit Node Markdown with the host's file tools. Text search belongs to those tools too. Tent's Node commands cover creation, structural changes and history: `node create`, `rename`, `move`, `archive`, `delete` and `history`.

`node create` saves body, type, optional `--description`, `--resource`, repeated `--source` and tags together; `--id` fixes the new id, so a retry cannot create a duplicate. Later body and frontmatter edits happen directly in the file. Structural commands retain their conflict checks, and receipts identify the saved Node and workspace. Role and Card commands keep their own read and write contracts (§8).

`node create --draft <file>` consumes a scan draft (§7). Each create entry has a unique `ref`; `@ref` can name its parent or another entry in links and materials. The command saves only entries whose bodies have been written: it first fixes their ids in the draft, saves them, removes them from the draft and rewrites remaining references to the saved ids. An entry whose parent still has an empty body stops the batch and names that parent. Retrying after an interruption creates the missing ids and skips those already saved, so it never duplicates a Node or loses a body. Saving the last entry deletes the draft and its report. This draft flow does not provide a general JSON batch write command.

Write receipts also give advice without changing anything stored. A newly declared whole Markdown file with several sections gets a hint to cite the sections the Node depends on.

Node mutation receipts also list `problems` for the Node documents that command actually wrote, using the same address, document and material checks as `workspace check`. They do not inspect unrelated Node bodies. The findings are advisory: the write stays saved, and a failure to inspect it is reported as a problem of that Node rather than a failed write.

### Native edits

Every Tent command that accesses the graph collects valid native Node edits before carrying out its command, except help, version, `tent new` and `card watch`. Help and version require no Tent and do not read or write its graph. Stop also collects the Node files edited during the turn (§5). Collection compares current files with their latest retained versions and records valid changes byte for byte. Invalid frontmatter is left untouched and reported, not recorded. Each collection keeps the bytes it sees, so intermediate edits between two collection points are not recoverable. Host file tools need no Tent write command.

### History

Each save records the exact bytes of the changed Node, Role and Card documents as one immutable event in `.tent/.git/history.sqlite`; the project's own Git is never written. An event has an opaque 64-hex id, a time, an operation name and the ids it touched. A version `{commit, path}` names one document in one event. `node history <id>` pages a Node's versions across moves; `node history <id> --version <v>` takes a JSON object `{commit, path}` and prints that document's complete raw bytes after checking its Node id and type, including after a later move or deletion. Historical raw documents may contain retired fields; current Node validation still rejects them. An edit and its revert are two events, so a change since a version stays a change after a revert. Diffs are line diffs with three lines of context. A save that changes nothing creates no event. A Node's `contentChangedAt` is the time of the last event that changed its body or material addresses; moves, tags and status do not count. When history cannot show that, or the file has uncollected changes, it is null rather than guessed.

### Safe writes and recovery

Tent writers share one on-disk mutation lock. A CLI write waits briefly for a busy lock, then names the lock it could not take; a live process is never evicted for age alone. Before changing files, a write records the exact before and after bytes of every affected file in a transaction journal. Files and the history database are not one transaction: the next Tent command settles an interrupted write to all old or all new before it reads anything. Bytes matching neither are external edits; they are kept and reported, and recovery never deletes unexpected content. Process termination is covered; what survives a power loss depends on the filesystem.

Damaged or unsupported history fails explicitly. Workspaces still on the old private-Git history are not read; `migrate-history.mjs` converts an offline copy once, as [MIGRATION.md](MIGRATION.md) describes.

Caches under `.tent/.git/` only make reads faster: deleting them changes no result, and a missing or broken cache falls back to reading files. A cached file observation is reused only while the file's size, times and identity match and the file is older than one second, so an edit that keeps all of those can be missed.

## 3. What a Node covers

`resource` names a Node's primary material; ordered `sources` list other related materials. A material is a local file, directory, file-name prefix or Markdown section, a Node, Role or Card document, or a remote URI, which Tent never fetches. Materials say what a Node rests on; they do not prove ownership or a complete impact set.

In stored documents, `./` and `../` resolve from the declaring file, a leading `/` resolves from `.tent`, and `file:` URIs are absolute; separators are `/`. At the CLI, new material paths start at the Workspace root and are stored document-relative. A trailing `/` marks a directory, and `./` declares a path that does not exist yet. A stored bare source is a description, whether or not a file of that name exists; only at the CLI does a bare path to an existing file become a file address. Ordinary files inside `.tent/` cannot be materials. `path.md#Heading` selects one Markdown section by its heading text: its version covers that heading through the next heading of the same or higher level, so edits elsewhere in the file do not count. A missing or duplicate heading makes the material unavailable.

Workspace directory members come only from the project's Git; Tent creates no private Git ignore context and uses no unfiltered directory walk. A `file:` directory outside that repository remains an address: Tent checks that it exists but never lists its members. Stop considers only changes in this Workspace's Git repository.

A local file, directory such as `src/api/`, or file-name prefix such as `src/flask/views*` supplies ordinary coverage through `resource` or `sources`. The most specific matching declarations win for each changed file: exact file references and references to a Markdown section that actually changed take priority; otherwise the nearest matching directory or prefix wins. Equally specific matches all remain. Coverage does not establish ownership, inherit rules from ancestors or depend on `type`. There is no `track` behavior. Invalid, duplicate-id and deprecated Nodes supply no current coverage. `description` is ordinary metadata and supplies none.

Markdown links, standard fields and bare `node-xxxxxx` tokens in a body relate Nodes to each other. Saves turn Node ids in links and materials into relative paths, and moves and renames rewrite the affected live links and materials, never historical Card input. A local body link must point to an existing file, or to an existing directory when it ends in `/`. `workspace check` reports unresolved links and missing materials.

## 4. Results

Create a Node with `node create --type output` and the relevant `--resource` or `--source` when a reusable result needs its own document. Later changes are direct file edits. Its type does not mark another Node complete or grant different coverage.

## 5. What the Agent is told

Tent reminds the Agent once at the end of a turn. The reminder points to the Nodes that cover changed files and reports problems in edited Node documents. The Agent reads and maintains those files with the host's tools. When nothing needs recording, it says nothing about Tent.

### Brief

`workspace brief [--role <role>]` first collects native edits, then reports within 16 KiB: up to ten recently changed Nodes with their change times, up to ten of the Role's unfinished Cards in queue order (pending, returned results, work awaiting return), and up to ten workspace problems (invalid documents, changed Card sources, uncertainty). Each row is one line of at most 120 code points; titles can be shortened, ids never are. Omitted rows are counted with the command that lists them. The Role filters Cards; Node and problem counts stay workspace-wide. Card delivery never proves a goal fulfilled, and a change time is a retained event, not proof of which session made it.

### Hooks

Both plugins register only Stop. The host shell translates its Stop input and output envelope; Core decides changed paths, coverage and the notice. A Stop explicitly marked by the host as following a previous Stop stays quiet, so a turn is continued at most once. Stop reads no transcript and registers no session.

Stop performs these steps in order:

1. **Compare the checkout with its previous Stop snapshot.** The snapshot keeps HEAD and content digests for uncommitted files. Comparison considers paths changed in commits between the previous and current HEAD, together with the current uncommitted paths, and compares their contents. With no previous snapshot, count current uncommitted files. Snapshots live in the shared `.tent` temporary directory, one per checkout, so linked worktrees have separate baselines. Files inside `.tent` never count as project-file changes. Before finishing, Stop saves the new checkout snapshot. A Workspace outside a Git repository produces no Stop notice.
2. **Select covering Nodes.** Read `resource` and `sources` from current Node frontmatter using §3's most specific matching rule. Reuse cached metadata only while the Node file remains unchanged. A section comparison reads only files changed this turn that have a section reference; unrelated material bodies are not read for coverage.
3. **Collect direct Node edits.** Record valid Node files edited during this turn in history, and retain the edited documents' concrete format problems for the notice. Compare problem-bearing documents with this checkout's previous Stop observation: unchanged invalid bytes do not produce another notice. A recursive Stop also advances that observation while staying quiet.
4. **Emit the notice.** Use the exact text below. When both sections are present they appear in this order, separated by one blank line. When both are empty, emit nothing. Node paths are absolute paths under the main checkout's `.tent`, including for a linked-worktree session. The notice contains pointers, without Node bodies, count limits, byte limits or truncation. The same state produces identical bytes.

```text
Files changed this turn are covered by these Tent Nodes:
- <name>: <absolute path>
If the change made a sentence in them wrong, fix it; if it settled something lasting, record it; otherwise say nothing about Tent.
```

```text
These Tent Node files have problems:
- <absolute path>: <problem>
```

5. **Meet the speed guardrail.** On a repository of 7,570 files, Stop adds at most 600 ms when few files changed and two seconds when all did. Each host's acceptance figure is the median of eleven adjacent alternating pairs of a Hook command and a bare `node` start. Keep the raw pairs and outliers. Measure project and actual-graph copies under `.scratch`; an overrun is reported before changing semantics to reduce time.

When neither an old section fingerprint nor old document text is available, a section is not counted as changed; whole-file and directory declarations can still supply coverage. Only changed files with section references are opened. Without a section record, use the previous checkout snapshot's HEAD text only when the file was clean in that snapshot; the first Stop uses the current HEAD. Previously dirty files without a section record remain unknown.

## 6. What a reader gets

Ordinary code work needs no Tent read first. Agents find and read Node files with the host's tools; Stop points to the Nodes that cover changed files (§5).

The first page of `card show` and `card take` carries an `agentContext`, gathered from the Card's sources. Its related-context lists have at most ten entries each and their complete totals:

- `references`: the source body or selected section, copied, up to 1600 code points;
- `paths`: files covered by the source Nodes' materials;
- `tests`: test files that statically import that code, each with the import that links it. A similar file name is no evidence, and an empty list means none were found, not that none exist;
- `changes`: for a pinned source, bounded line diffs from its pinned version to its latest retained one;
- `decisions`: Nodes and files the body links to or names, and Nodes that link to it;
- `open`: unfinished Cards whose sources are these Nodes;
- `unknown`: what could not be determined, and why.

Node types do not select inherited rules or infer an open or completed goal. Material paths use ordinary coverage (§3).

Every assembled entry states the relationship that selected it. Text is copied, never summarized, and gathering it repairs nothing. The whole response fits 16 KiB, with the primary body taking at most half; when room runs out, later lists shrink to titles and then drop out, each marked, and ids and addresses are never shortened. A Card source keeps its pinned version. `node-xxxxxx#Heading` or a link ending in `#Heading` selects one section of a source; a missing or duplicate heading becomes an unknown, and the source's pinned opening stands in for the section, never today's text. Tent records no session boundary, so what the last session did is unknown. Raw views, `--full` and continuation pages carry no `agentContext`.

## 7. Mapping a project

In an empty Workspace, `workspace scan` reports facts for planning parts from the current checkout: coverage, directory imports and cycles, generated directories, file-name groups and guidance files. It runs no model and changes no Node content; like other CLI invocations it first collects native edits. A workspace that is not a Git checkout fails. Text output is a short overview with `+N more` counts; `--json` has every fact. Guidance files are the usual project documents (README, AGENTS, CLAUDE, CONTRIBUTING, ARCHITECTURE, DESIGN and the like, `.cursor/rules`) and Markdown or text under top-level `docs/` or `doc/`. `package.json` entry points and Claude Code and Codex plugin manifests mark product boundaries even where there is no parseable code.

`workspace scan --draft <file>` writes an editable map draft and a JSON Lines report beside it whose name ends `.report.json`. It refuses to overwrite either file. Each proposed part has an empty body and a `resource` pointing to its directory or file-name prefix, without a tracking field; real directory layers become parents and children. Leaf parts aim at ten code files or fewer, tests excluded: large directories split along subdirectories, flat directories by load-time imports, then by file-name stems. Only `module-load` imports group files. Generated files and adjacent tests stay with their source; a separate test tree becomes a Tests part, other root files become Setup, and each top-level `docs/` tree becomes one Docs part. The report records each part's files, tests, co-changing parts, history and findings. The Agent adjusts names and boundaries, writes useful bodies and saves them with `node create --draft <file>` (§2); empty-body Nodes never enter the graph.

When the Workspace already has any Node, `workspace scan` creates no draft and reports only map problems using ordinary file, directory and prefix coverage without ownership or type rules. Every Node that covers files is a part, and each file belongs to its most specific matching part. Findings name the involved Nodes and files, with import and co-change evidence and one suggested fix. Clean text output is silent with exit 0; findings produce exit 1. `--json` directly returns the report fields together with `parts`: the report includes the findings, each part's files, `testedBy` and `coChanges`; `parts` is a tree whose entries contain `name`, `path`, `files` and `children`. Tracked files with no coverage are reported as `map.uncovered`; there is no separate unowned-code finding. Import extraction uncertainty is reported rather than guessed.

The report uses the latest 300 first-parent commits and these rules:

- `map.uncovered`: tracked files no Node covers;
- `module.oversized` and `module.skewed`: a leaf part with at least 20 production code files (tests, generated and vendored files do not count) that holds more than 20% of the project's, or more than three times the median of its other non-empty siblings, and has at least two groups of three or more files that could split;
- `deps.cycle`: two parts, neither inside the other, load each other, with at least three imports in the smaller direction and at least 10% of the larger, not counting tests or `index` barrel files;
- `history.always-together`: two parts share at least five commits, at least 90% of the less-changed one's, with lift of at least two; commits touching more than 50 files are left out;
- `history.generated-apart`: the same, where one part is mostly generated files.

A Node keeps an intended exception with a line `allow:<rule>` in its own body. A pair rule also needs a link to the other Node on that line. `map.uncovered` cannot be excepted.

Imports are read from TypeScript, JavaScript, Python, Go, Rust, Java, C#, C, C++ and PHP source as written, without running code, compilers or build tools. Each import is classed as `module-load` (loads when the file loads), `deferred` (inside a function), `type-only` or `compile-time` (Rust, Java, C#, C/C++ and PHP name dependencies). A name the extractor cannot resolve to one local target is reported, never guessed; a PHP include that depends on the runtime include path links each existing candidate, marked uncertain. What each language's extractor follows, and where it stops, is documented with its code and tests.

`workspace check` reports broken links, invalid or missing materials, missing sections, and Node files that disagree with retained history (`node-git-mismatch`), and lists documents it could not inspect. It exits 1 when there is anything to report. It checks that things exist, not whether they are still right.

## 8. Handing work over

### Roles

A Role is one document at `roles/<role-id>.md` with `type: role`, an id and an optional title. It holds a direction of work, its boundaries, its way of working and links to Nodes; shared facts stay in Nodes. Selecting a Role is explicit: reading it binds no session, claims nothing and repairs nothing, and a new conversation can read the same Role to pick up its direction. `role create`, `role show`, `role write --base-etag` and `role list` (deprecated Roles only with `--include-deprecated`) follow the ordinary read and write rules. `role delete --base-etag` removes the document for good; its id is never reused. Deleting a Role, or marking it deprecated, is refused while a Card still waits on it: pending for it, to be returned to it, or received by it and not yet returned. The refusal lists those Cards.

### Cards

A Card is one document at `cards/<card-id>.md` with an optional title, ordered `sources`, an optional `target` Role, an optional `returnTo` Role and a prompt as its body. Creation publishes it at once; there are no Card drafts. Each Node or Role source is pinned to the version current at creation, so the receiver reads exactly what the sender saw and can compare it with the current version. A source can select one section as `node-xxxxxx#Heading`; `card create` warns when that heading is missing. External addresses are neither fetched nor pinned. `card create` warns on stderr, without changing what it stores, when an explicit path source (starting `./`, `/` or `.tent/`) names nothing that exists. A Card records no sender. Body, title, sources and `returnTo` never change after publication; a hand edit is readable but blocks taking and returning with `INPUT_CHANGED`. Requirements that change belong in Nodes.

A Card is `pending`, then `consumed` when it is taken: by its target Role, or, for a public Card with no `returnTo`, by any session without a Role. With `returnTo` it goes on to `returned` when the receiver returns a result, and to `closed` when the `returnTo` Role takes that result. Without `returnTo`, consumed means complete; with it, returned means complete and closed means the result was collected. `card take <id> --role <role>` receives a pending Card, or collects a returned one, under the mutation lock; repeating the same take is a replay that grants no second execution. `card return <id> --role <role> --result <text>` records a result of one line and at most 200 characters; details go in Nodes, whose ids may appear in it. Returning the same text again is a replay; different text is rejected. A Card shows delivery state only: no progress, goal counts or output lists are derived from it.

Each Role has an ordered queue of pending Cards, oldest first by default; the public area holds untargeted Cards and is shown only on request. `card move <id> [--to <role> | --public] [--before <id> | --after <id>] --base-etag <etag>` reorders a pending Card or sends it to another Role, writing only that Card. `card deprecate <id> --base-etag <etag>` cancels a Card, even after it was taken, keeping what was received; lists and brief leave deprecated Cards out unless asked, and an explicit `show` or `take` still works and warns. `card list` filters by Role and state. `card watch --role <role> [--include-open] [--timeout <seconds>]` waits until a pending Card for that Role, or a result returned to it, exists, then prints one line per Card: the command to take a pending Card, or the result of a returned Card; it exits 0 with input, 2 on timeout and 1 on error, and receives nothing itself. Taking a public Card claims it; of two concurrent claims one wins and the other is told who.

While a Card is in progress, brief lists its pinned sources that changed since pinning, so the receiver rereads them. Creating a Node does not choose a Card or return its result; Card delivery and return remain explicit operations.

## 9. Everything else

### Plugins and Skills

One build makes the Codex and Claude Code packages from the same CLI, four Skills, references and this specification; each host gets a thin shell for its manifest, hook definitions and launcher. `tent-init` creates a Tent and maps a project, `tent-node` reads and maintains Nodes, `tent-role` takes on or keeps a Role, and `tent-card` sends and receives Cards. Command details live in references read on demand, and apart from mapping a project, no Skill asks for a fixed reading order, and none asks for a per-turn Node count or a full-tree pass. The plugin runs from its installed path, keeps no graph data in the plugin cache, installs no global hook copies and configures no MCP server. Building, installing, trusting the hooks and real event delivery are separate checks; a package being present proves none of the others.

### Build identity

`tent --version` prints the version, commit and build time; `tent version --json` returns `version`, `commit`, `builtAt`, `dirty` and `runtimePath`. A built CLI carries its identity wherever it is installed. This is local provenance, not an update check.

### Export

`tent workspace export --output <new-directory>` copies the whole graph, with its history, Roles, Cards and other retained files, to a new directory under the Workspace's `output/` or `.scratch/` and verifies the copy against the source. Tent's own locks, temporary files and caches are left out; any other file under `.tent/` is copied as it is. Materials outside `.tent/` are not copied: the export lists them in `externalNotPacked`, and bare or invalid ones in `unresolvedMaterials`. A pending write, invalid history or a missing local material referenced inside `.tent/` stops the export. Like other commands it first collects native edits; the copy itself never changes the source.
