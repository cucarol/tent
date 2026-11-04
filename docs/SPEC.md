# Tent Specification

This is Tent's public contract: what Tent does, as seen through its files, CLI and hooks. The rules live in `src/core/`; the CLI and the plugin packages stay thin. Retired commands and fields are removed, not aliased. How a rule is implemented, such as caches, indexes and the files inside `.tent/.git`, is documented in the code beside it.

The sections after the first follow the question each group of mechanisms answers: how things are kept, what a Node covers, how results are recorded, what the Agent is told, what a reader gets, how a project is mapped, how work is handed over, and the rest.

## 1. Purpose and workspace

Node, Role and Card are the only concepts. Tent keeps the context of a project's agent sessions as a graph: a Node records one thing in that context, a Role keeps a direction of work, and a Card hands one input to a Role. Normal work, answers, code edits, review and Git stay in the host conversation and the user's tools; ordinary tasks need no Role or Card. Tent has no managed Agent, session registry, task scheduler or background service.

A workspace is a directory inside a Git repository that contains `.tent/`. Git is required. Its `workspaceId` in `.tent/settings.json` survives relocation; a missing or corrupt identity fails explicitly. Discovery walks up from the current directory and stops at a Git checkout boundary. From a linked worktree it follows the `.git` pointer to the main checkout's `.tent/`, so Node edits land in the main checkout. Ordinary material reads use the main checkout; Stop compares the originating checkout and matches coverage by its workspace-relative paths (§5). Submodules, nested clones and bare repositories do not inherit a parent workspace. `--workspace` overrides discovery.

`tent new <workspace>` first runs `git init` in that directory if it is not already inside a Git repository, then publishes an empty `.tent/` with its own history. An existing repository or linked worktree is left unchanged. When initialization is needed, it prints `Initialized a Git repository in <root>` before `Created Tent`, with the actual root path. If Git cannot be found, it fails with `Tent needs Git; install Git, then run tent new <root>`. It never replaces an existing `.tent/`, edits project files or creates Nodes. It writes `.tent/.gitignore` containing `*`, so Git ignores the whole Tent without changing the project's Git exclude configuration. Deleting `.tent/` leaves the project working: builds, tests and project documents never depend on it. Project instructions stay in the project's own files, such as `AGENTS.md`.

## 2. Keeping things

### Nodes

A Node is a directory holding `<name>/<name>.md`. A directory without that file is a plain grouping folder. Placement gives the parent and child tree; the `node-…` id is the stable handle across moves and renames. The file name is the display name; a `title` field, if present, is kept aligned with it. Names must be valid Windows file names on every platform: `< > : " / \ | ? *`, a trailing dot, C0 control characters (U+0000–U+001F), DEL (U+007F), U+2028, U+2029 and the reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, `COM¹`–`COM³` and `LPT¹`–`LPT³`, with or without an extension) are rejected, and surrounding whitespace is trimmed.

`type` is required and is exactly `goal`, `prompt` or `output`; any other value makes the document an invalid Node, in retained versions too. Each type records a different source, and the Node is corrected against it: a `goal` records what the work is for, as the user wants it now; a `prompt` records what is given to get there, such as requirements, constraints, decisions with their reasons, references and ways of working; an `output` records what came out, as it is now. A prompt or output sits under the goal it serves. Coverage, reading and writing are the same for every type; `tent load` gathers prompts through goals, Stop names changed goals (§5), and `workspace scan` takes goals as a project's parts (§7). `description` is an optional one-sentence string; a non-string value is a document problem reported by `workspace check`. Form and topic go in `tags`: free text without path separators or line breaks, any number, no behavior. Unknown YAML fields survive every edit. Invalid identity or type data and duplicate ids are reported, never silently repaired.

Record what will help later work: confirmed goals and constraints, decisions with their reasons, reference pointers, observed findings and facts about real results. A result that did not happen cannot be recorded. An undecided matter is asked in conversation or sent as a Card to the Role that decides it, and the settled result is recorded.

`status` is `stable` or `deprecated` (OKF v0.2 §5.4); omitted means stable, and Tent never changes it on its own. OKF's `draft` counts as stable. An unknown value is kept and reported, and that Node supplies no coverage until it is fixed. Status belongs to one Node: the children of a deprecated Node keep their own. A deprecated Node stays readable and editable but drops out of current coverage. `node archive <id>` marks a subtree deprecated in one event; to bring a Node back, set its `status` again. `node delete` removes a subtree; it leaves materials and inbound links alone.

### Reading and writing

Agents find, read and edit Node Markdown with the host's file tools. Text search belongs to those tools too. Tent's Node commands cover creation, structural changes and history: `node create`, `rename`, `move`, `archive`, `delete` and `history`.

`node create` saves body, type, optional `--description`, `--resource`, repeated `--source` and tags together; `--id` fixes the new id, so a retry cannot create a duplicate. Later body and frontmatter edits happen directly in the file. Structural commands retain their conflict checks, and receipts identify the saved Node and workspace. Role and Card commands keep their own read and write contracts (§8).

`node create --draft <file>` consumes a scan draft (§7). Each create entry has a unique `ref`; `@ref` can name its parent or another entry in links and materials. The command saves only entries whose bodies have been written: it first fixes their ids in the draft, saves them, removes them from the draft and rewrites remaining references to the saved ids. An entry whose parent or linked entry still has an empty body, or that links a ref the draft does not hold, stops the batch before anything is written and names that ref. Retrying after an interruption creates the missing ids and skips those already saved, so it never duplicates a Node or loses a body. Saving the last entry deletes the draft and its report. This draft flow does not provide a general JSON batch write command.

Write receipts also give advice without changing anything stored. A newly declared whole Markdown file with several sections gets a hint to cite the sections the Node depends on.

Node mutation receipts also list `problems` for the Node documents that command actually wrote, using the same address, document and material checks as `workspace check`. They do not inspect unrelated Node bodies. The findings are advisory: the write stays saved, and a failure to inspect it is reported as a problem of that Node rather than a failed write.

### Native edits

Every Tent command that accesses the graph collects valid native Node edits before carrying out its command, except help, version, `tent new` and `card watch`. Help and version require no Tent and do not read or write its graph. Stop also collects the Node files edited during the turn (§5). Collection compares current files with their latest retained versions and records valid changes byte for byte. Invalid frontmatter is left untouched and reported, not recorded. Each collection keeps the bytes it sees, so intermediate edits between two collection points are not recoverable. Host file tools need no Tent write command.

### History

Each save records the exact bytes of the changed Node, Role and Card documents as one immutable event in `.tent/.git/history.sqlite`; the project's own Git is never written. An event has an opaque 64-hex id, a time, an operation name and the ids it touched. A version `{commit, path}` names one document in one event. `node history <id>` pages a Node's versions across moves; `node history <id> --version <v>` takes a JSON object `{commit, path}` and prints that document's complete raw bytes after checking its Node id and type, including after a later move or deletion. Historical raw documents may contain retired fields; current Node validation still rejects them. An edit and its revert are two events, so a change since a version stays a change after a revert. Diffs are line diffs with three lines of context. A save that changes nothing creates no event.

### Safe writes and recovery

Tent writers share one on-disk mutation lock. A CLI write waits briefly for a busy lock, then names the lock it could not take; a live process is never evicted for age alone. Before changing files, a write records the exact before and after bytes of every affected file in a transaction journal. Files and the history database are not one transaction: the next Tent command settles an interrupted write to all old or all new before it reads anything. Bytes matching neither are external edits; they are kept and reported, and recovery never deletes unexpected content. Process termination is covered; what survives a power loss depends on the filesystem.

Damaged or unsupported history fails explicitly.

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

Tent speaks at the two ends of a turn's work. Before a change, `tent load` points the Agent to the Nodes for the files it is about to change. At the end of a turn, Stop reminds the Agent once: it points to the Nodes that cover changed files or says that none does, names goals that changed, and reports problems in edited or listed Node documents. The Agent reads and maintains those files with the host's tools. When nothing needs recording, it says nothing about Tent.

### Load

`tent load <path>...` resolves each path from the current directory against the originating checkout, as Stop does, and lists the Nodes covering those files by §3's most specific rule, with every section reference counted as matching. It then lists the direct `prompt` children of each covering Node and of every `goal` above it, nearest first; a Node reached twice is listed once, and invalid or deprecated Nodes are left out. It collects native edits first and writes nothing else.

```text
These Tent Nodes cover <path>[, <path>…]:
- <name> (<type>): <absolute path> — <description>

Prompts above them, nearest first:
- <name> (prompt): <absolute path> — <description>
```

A Node without a description drops ` — <description>`; with no prompts the second block is left out. With no covering Node it prints `No Tent Node covers <path>[, <path>…].` A path outside the Workspace fails with `<path> is outside the Workspace at <root>.`

### Hooks

Both plugins register only Stop. The host shell translates its Stop input and output envelope; Core decides changed paths, coverage and the notice. A Stop explicitly marked by the host as following a previous Stop stays quiet, so a turn is continued at most once. Stop reads no transcript and registers no session.

Stop performs these steps in order:

1. **Compare the checkout with its previous Stop snapshot.** The snapshot keeps HEAD and content digests for uncommitted files. Comparison considers paths changed in commits between the previous and current HEAD, together with the current uncommitted paths, and compares their contents. With no previous snapshot, count current uncommitted files. Snapshots live in the shared `.tent` temporary directory, one per checkout, so linked worktrees have separate baselines. Files inside `.tent` never count as project-file changes. Before finishing, Stop saves the new checkout snapshot, together with the Tent history position it saw and the reference problems it has reported. A Workspace outside a Git repository produces no Stop notice.
2. **Select covering Nodes.** Read `resource` and `sources` from current Node frontmatter using §3's most specific matching rule. Reuse cached metadata only while the Node file remains unchanged. A section comparison reads only files changed this turn that have a section reference; unrelated material bodies are not read for coverage.
3. **Collect direct Node edits.** Record valid Node files edited during this turn in history, and retain the edited documents' concrete format problems for the notice. Compare problem-bearing documents with this checkout's previous Stop observation: unchanged invalid bytes do not produce another notice. A recursive Stop also advances that observation while staying quiet. For Nodes selected in step 2 that were not edited, report only references to files or sections that no longer exist, once per Node and problem until the problem changes.
4. **Name changed goals.** Read the Tent history since this checkout's previous Stop. A Node that is or was a `goal` and whose type, description, status or body changed, including creation, archiving and deletion, is named; moves, renames, tag changes and whitespace at the end of the body alone are not. History does not record which session made a change, so changes from other sessions in that window count too. Without a previous history position nothing is named.
5. **Emit the notice.** Use the exact text below. Sections appear in this order, separated by one blank line: the covered Nodes, or the uncovered reminder when files changed and no Node covers any of them even counting every section reference; the changed goals; the problems. When all are empty, emit nothing. Node paths are absolute paths under the main checkout's `.tent`, including for a linked-worktree session. The notice contains pointers, without Node bodies, count limits, byte limits or truncation. The same state produces identical bytes.

```text
Files changed this turn are covered by these Tent Nodes:
- <name> (<type>): <absolute path>

Correct each against what it records: a goal against what the user wants now, a prompt against the decisions made, an output against the workspace. Record anything lasting the turn settled. Leave a Node that still matches as it is, and if nothing changed say nothing about Tent: a check that changed nothing is noise to the user.
```

```text
No Tent Node covers the files changed this turn. If the turn settled something a later session should start from — what the work is for, what was given to get there, or what came out — record it. Otherwise say nothing about Tent: a check that changed nothing is noise to the user.
```

```text
These goals changed this turn:
- <name>: <absolute path>

A goal changes only when the user's will does. If the user has not been told, tell them what changed and why. If the edit only made the goal fit the work, undo it and tell the user the work differs from the goal. Leave an edit you did not make; another session answers for it.
```

```text
These Tent Node files have problems:
- <absolute path>: <problem>
```

6. **Meet the speed guardrail.** On a repository of 7,570 files, Stop adds at most 600 ms when few files changed and two seconds when all did. Each host's acceptance figure is the median of eleven adjacent alternating pairs of a Hook command and a bare `node` start. Keep the raw pairs and outliers. Measure project and actual-graph copies under `.scratch`; an overrun is reported before changing semantics to reduce time.

When neither an old section fingerprint nor old document text is available, a section is not counted as changed; whole-file and directory declarations can still supply coverage. Only changed files with section references are opened. Without a section record, use the previous checkout snapshot's HEAD text only when the file was clean in that snapshot; the first Stop uses the current HEAD. Previously dirty files without a section record remain unknown.

## 6. What a reader gets

Tent hands out pointers, never copied bodies. Before files change, `tent load` lists the Nodes that cover them and the prompts that apply; after, Stop lists the Nodes covering the changed files (§5); taking a Card prints its task and where each source is now (§8). Agents read Node, Role and Card files with the host's tools.

## 7. Mapping a project

In an empty Workspace, `workspace scan` reports facts for planning parts from the current checkout: coverage, directory imports and cycles, generated directories, file-name groups and guidance files. It runs no model and changes no Node content; like other CLI invocations it first collects native edits. A workspace that is not a Git checkout fails. Text output is a short overview with `+N more` counts; `--json` has every fact. Guidance files are the usual project documents (README, AGENTS, CLAUDE, CONTRIBUTING, ARCHITECTURE, DESIGN and the like, `.cursor/rules`) and Markdown or text under top-level `docs/` or `doc/`. `package.json` entry points and Claude Code and Codex plugin manifests mark product boundaries even where there is no parseable code.

`workspace scan --draft <file>` writes an editable map draft and a JSON Lines report beside it whose name ends `.report.json`. It refuses to overwrite either file, and writes the report first, so a draft always has its report. Each proposed part is a `goal` with an empty body and a `resource` pointing to its directory, file-name prefix or files, without a tracking field. Every real directory layer becomes a part, with parents and children, whatever its files are. A part's size counts the files an Agent reads: code, prose, data and configuration. Tests, generated and vendored files, lockfiles and binary assets do not count. Assets such as images, audio, video, fonts, PDFs and archives are known by their extension, a file with any other extension by a NUL byte in its first 8 KiB; they stay in their directory's part. Leaf parts aim at ten counted files or fewer. A large directory splits along its subdirectories; then code splits by load-time imports and file-name stems, and other text by shared file-name prefixes and then by files that change together in history. Only `module-load` imports group files, and text and asset layers never take code from the part its imports put it in. Generated files and adjacent tests stay with their source. A separate test tree becomes a Tests part, a top-level `docs/` or `doc/` tree is named Docs, and loose root files become Root files; when more than ten of them count, groups with a shared prefix or history become parts of their own first. Tent never splits by numbering or size alone: a large part with no evidence to split it stays whole, and the printed receipt warns `Large part with no split Tent can see: <path> (<n> files). Split it into the units this project uses, such as chapters or episodes, or keep it whole.` The report records each part's files, tests, co-changing parts, history and findings. The Agent adjusts names and boundaries, writes useful bodies and saves them with `node create --draft <file>` (§2); empty-body Nodes never enter the graph.

When the Workspace already has any Node, `workspace scan` creates no draft and reports only map problems. Every current goal that covers files is a part, and each file belongs to its most specific matching part by ordinary file, directory and prefix coverage, without ownership rules. A prompt or output that names files still covers them for `tent load` and Stop but is not a part, so those files stay with their goal. Findings name the involved Nodes and files, with import and co-change evidence and one suggested fix. Clean text output is silent with exit 0; findings produce exit 1. `--json` returns the report fields together with `parts`: the report includes the findings and `partFacts`, with each part's files, counted `textFiles`, `testedBy` and `coChanges`; `parts` is a tree whose entries contain `name`, `path`, `files` and `children`. Tracked files no part covers are reported as `map.uncovered`; there is no separate unowned-code finding. Import extraction uncertainty is reported rather than guessed.

The report uses the latest 300 first-parent commits and these rules:

- `map.uncovered`: tracked files no goal covers;
- `part.oversized` and `part.skewed`: a leaf part with at least 20 counted files, counted as in the draft, that holds more than 20% of the project's, or more than three times the median of its other non-empty siblings, and has at least two groups of three or more such files, by subdirectory or file-name stem, that could split;
- `deps.cycle`: two parts, neither inside the other, load each other, with at least three imports in the smaller direction and at least 10% of the larger, not counting tests or `index` barrel files;
- `history.always-together`: two parts share at least five commits, at least 90% of the less-changed one's, with lift of at least two; commits touching more than 50 files are left out;
- `history.generated-apart`: the same, where one part is mostly generated files.

A Node keeps an intended exception with a line `allow:<rule>` in its own body. A pair rule also needs a link to the other Node on that line. `map.uncovered` cannot be excepted.

Imports are read from TypeScript, JavaScript, Python, Go, Rust, Java, C#, C, C++ and PHP source as written, without running code, compilers or build tools. Each import is classed as `module-load` (loads when the file loads), `deferred` (inside a function), `type-only` or `compile-time` (Rust, Java, C#, C/C++ and PHP name dependencies). A name the extractor cannot resolve to one local target is reported, never guessed; a PHP include that depends on the runtime include path links each existing candidate, marked uncertain. What each language's extractor follows, and where it stops, is documented with its code and tests.

`workspace check` reports broken links, invalid or missing materials, missing sections, and Node files that disagree with retained history (`node-git-mismatch`), and lists documents it could not inspect. It exits 1 when there is anything to report. It checks that things exist, not whether they are still right.

## 8. Handing work over

### Roles

A Role is one document at `roles/<role-id>.md` with `type: role`, an id and an optional title. It holds a direction of work, its boundaries, its way of working and links to Nodes; shared facts stay in Nodes. Selecting a Role is explicit: reading it binds no session, claims nothing and repairs nothing, and a new conversation can read the same Role to pick up its direction. `role create` makes one; after that its file is read and edited with the host's own tools, and Tent history keeps only the versions Tent writes. `role delete <role>` removes the document for good; its id is never reused. A Card waits on a Role while it is pending for it, taken by it and not yet returned, or returned to it and not yet collected. Deleting a Role is refused while a Card waits on it, and the refusal lists those Cards; `workspace check` reports a Card that waits on a Role that is deprecated or gone.

### Cards

A Card is one document at `cards/<card-id>.md` with an optional title, ordered `sources`, a `target` Role, an optional `returnTo` Role and the task as its body. Creation publishes it at once; there are no Card drafts. Sources are addresses: a Node, one section of it as `node-xxxxxx#Heading`, a Role, a Card, a Workspace path, a URI or descriptive text. Tent checks that Node and Role sources exist when the Card is created and copies nothing from them; the receiver reads them with its own tools. `card create` warns, without changing what it stores, when a selected heading is missing or an explicit path source (starting `./`, `/` or `.tent/`) names nothing that exists. A Card records no sender. Body, title, sources, `target` and `returnTo` never change after publication; a hand edit is readable but blocks taking and returning with `INPUT_CHANGED`. Requirements that change belong in Nodes.

A Card is `pending`, then `consumed` when its target Role takes it. With `returnTo` it goes on to `returned` when the receiver returns a result, and to `closed` when the `returnTo` Role takes that result. Without `returnTo`, consumed means complete; with it, returned means complete and closed means the result was collected. `card take <id> --role <role>` receives a pending Card, or collects a returned one, under the mutation lock; repeating the same take is a replay that grants no second execution. Taking a Card prints its task and, for each source, a name and where it is now: a Node source follows the identity it had when the Card was published, so a renamed or moved Node is still found and a deleted one is marked by its id, never by whatever Node now has its path; a path that names nothing is marked too. `card return <id> --role <role> --result <text>` records a result of one line and at most 200 characters; details go in Nodes, whose ids may appear in it. Returning the same text again is a replay; different text is rejected. A Card shows delivery state only: no progress, goal counts or output lists are derived from it.

A Role's pending Cards queue in publication order. `card list --role <role>` shows what waits for that Role: Cards to take, then returns it owes, then results returned to it; with `--state` it lists the Cards in that state that name the Role. `card deprecate <id>` cancels a Card, even after it was taken, keeping what was received; to change a task or its Role, cancel the Card and send a new one. Lists leave deprecated Cards out unless asked, and taking one still works and says it was cancelled. `card watch --role <role> [--timeout <seconds>]` waits until a pending Card for that Role, or a result returned to it, exists, then prints one line per Card: the command to take a pending Card, or the result of a returned Card; it exits 0 with input, 2 on timeout and 1 on error, and receives nothing itself.

## 9. Everything else

### Plugins and Skills

One build makes the Codex and Claude Code packages from the same CLI, four Skills, references and this specification; each host gets a thin shell for its manifest, hook definitions and launcher. Each Skill serves one moment: `tent-init` creates a Tent and maps a project, `tent-load` gathers the Nodes for a change before it is made, `tent-save` records what work settled and corrects Nodes against their sources, and `tent-role` takes on or keeps a Role and hands work over with Cards. Command details live in references read on demand, and apart from mapping a project, no Skill asks for a fixed reading order, and none asks for a per-turn Node count or a full-tree pass. The plugin runs from its installed path, keeps no graph data in the plugin cache, installs no global hook copies and configures no MCP server. Building, installing, trusting the hooks and real event delivery are separate checks; a package being present proves none of the others.

### Build identity

`tent --version` prints the version, commit and build time; `tent version --json` returns `version`, `commit`, `builtAt`, `dirty` and `runtimePath`. A built CLI carries its identity wherever it is installed. This is local provenance, not an update check.

### Export

`tent workspace export --output <new-directory>` copies the whole graph, with its history, Roles, Cards and other retained files, to a new directory under the Workspace's `output/` or `.scratch/` and verifies the copy against the source. Tent's own locks, temporary files and caches are left out; any other file under `.tent/` is copied as it is. Materials outside `.tent/` are not copied: the export lists them in `externalNotPacked`, and bare or invalid ones in `unresolvedMaterials`. A pending write, invalid history or a missing local material referenced inside `.tent/` stops the export. Like other commands it first collects native edits; the copy itself never changes the source.
