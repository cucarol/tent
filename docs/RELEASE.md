# Tent release notes

## Next release (version set at tag time)

Tent is a project's context graph. This release makes it show what is ahead, goals nothing implements yet, and what is behind, facts whose material changed.

### Node types and tags

- A Node's `type` is exactly `goal`, `prompt` or `output`. Form and topic belong in `tags`. Any other type value, including the former `goal|prompt|output-<label>` form, makes the document an invalid Node.
- Tent suggests ten tag presets, such as `decision` and `evidence`. `tent node tags` lists the tags in use with their counts.
- `tent node type` and `tent node tags set|add|remove` change a Node's type and tags under an ETag.
- `tent node list --type <type> --tag <tag>` selects matching Nodes from a whole subtree.

### Ahead and behind

- Saving a Node records the versions of its `resource` and `sources` in `.tent/.git`. The Markdown carries no hash fields.
- `tent node check`, `tent workspace drift` and `tent workspace brief` report two findings. A goal with no current output under it is ahead. A Node whose material changed, or whose `stale_after` time has passed, is behind.
- Behind propagates down the goal chain. Changing a goal's body or material makes every output under it behind, including through nested goals. Confirming the goal does not confirm its outputs.
- Every current output under a goal counts as implementing it, whatever its tags.
- `tent node confirm` records a review and refreshes the Node's versions. `tent node write --confirm` saves and confirms together. Rewriting an output's whole body also refreshes its dependencies.
- A Markdown material can track one section, as in `docs/design.md#State`.
- A tracked file missing from the workspace checkout is read from another checkout of the same repository, unless the main checkout also lacks it and its history deleted that path.
- `tent workspace brief` fits in 4 KiB. It also lists Card inputs and recently written files that no output records.

### Writing Nodes

- `tent node append` adds text without a prior read or ETag.
- `tent node get-section` and `tent node write-section` replace one Markdown section; edits to other sections do not conflict.
- Writes record OKF `generated` and confirmations record `verified`, each with an actor. `--by` names the actor.
- File paths in `--resource`, `--sources-json`, `tent card create --source` and `tent node link-output --resource` resolve from the workspace root.
- Node names follow Windows file-name rules on every platform.
- `tent node get` adds a bounded `context` of related Nodes and Cards.
- `tent workspace check` also reports missing Markdown sections and Node files that disagree with Tent Git.
- CLI writes wait briefly for a busy lock instead of failing at once.

### Cards

- Card progress comes from outputs whose `sources` name the Card; `tent node link-output --card <id>` records that link.
- A pending Card shows `pending`. A received Card shows `has-output` when every remaining goal has a current responding output. Otherwise it shows `needs-review` if an unfinished goal has a responding output awaiting review, such as a behind one, and `received-no-output` if not. A Card without goal sources, or whose goals are all deprecated, has no progress.
- `tent card deprecate` cancels a Card and keeps its input and reception. The interrupted state, `interrupt` and `continue` are removed.
- `tent card watch --role <role-id>` waits for pending Cards addressed to that Role.
- `tent card show` and `tent card take` list each source with its name, id and pinned version.
- When a source Node of a received Card changes, the brief asks the receiver to reread it.

### Web UI

- The page opens on Now: Role work from Card progress, outputs since your last visit, and current ahead and behind findings.
- The map marks ahead and behind Nodes and Cards awaiting review. Nodes can be confirmed from the page.
- Unsent Card drafts stay in the browser until you send them.
- The built-in Excalidraw annotations are removed. Save a sketch with Excalidraw as a workspace file and reference it from a Node.

### Skills and Hooks

- The four Skills are short checklists: when to act, which command to run and which field to read. All Agent-facing text stays under 12 KB.
- SessionStart states the workspace, the CLI, the build identity and a `tent workspace brief` hint.
- Stop states at most three findings: written files that no output records, changed materials that make a Node behind, and possible new decisions.

### Development

- The OKF specification is pinned in `docs/upstream/`. `npm run okf:upstream` reports upstream drift.

## 0.1.1

Tent is a local Markdown context graph for coding agents, with a CLI, four Skills, two optional Hooks, and a local web UI.

- Nodes hold durable facts and decisions, Roles describe continuing work directions, and Cards preserve one input with pinned context references.
- The web UI can browse and edit the graph, create Cards, annotate the map, and switch workspaces.
- Context history lives in `.tent/.git`. ETag checks protect document updates, and incomplete CLI reads cannot be used to replace a document.

### Changes since 0.1.0

- The project is now named Tent. The repository is [cucarol/tent](https://github.com/cucarol/tent); old `vibe-tent` links redirect.
- The npm package `vibe-tent` now carries this product, so `npm install -g vibe-tent` works. The earlier `vibe-tent@0.1.0` on npm was the Obsidian plugin and is deprecated.
- Path checks treat `\` as a separator on every platform, so escaping paths are rejected on Linux and macOS as on Windows.
- Creating a Tent on Windows retries a directory rename that antivirus or indexing briefly blocks.

### Install

Node.js 22.19+ and Git are required.

For Codex, download and extract `tent-plugin-0.1.1.zip`. Keep the extracted `.agents/` and `plugins/` directories together, then run:

```sh
codex plugin marketplace add "<absolute path to the extracted folder>"
codex plugin add tent@tent-local
```

Review the SessionStart and Stop Hooks in Codex before enabling them. Tent's CLI works without Hooks.

For the standalone CLI:

```sh
npm install -g vibe-tent
tent --help
```

The same package is attached as `vibe-tent-0.1.1.tgz`. It installs the CLI and its dependencies, but does not register a Codex plugin. See the [English README](https://github.com/cucarol/tent/blob/main/README.md) or [中文说明](https://github.com/cucarol/tent/blob/main/README.zh-CN.md) for usage and source builds.

### Current limits

There is no evidence yet that Tent improves on ordinary notes; the README's Status section describes the studies so far. The format and commands are still early. This is a replacement distribution, not an upgrade for the old Obsidian plugin.

The public repository starts from a clean root containing the current product. Earlier product history is retained locally by the maintainer.
