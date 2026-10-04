# Tent 0.1.0

Tent now provides a local Markdown context graph for coding agents, with a CLI, four Skills, two optional Hooks, and a local web UI. This release replaces the earlier Obsidian plugin distribution; the version remains 0.1.0.

- Nodes hold durable facts and decisions, Roles describe continuing work directions, and Cards preserve one input with pinned context references.
- The web UI can browse and edit the graph, create Cards, annotate the map, and switch workspaces.
- Context history lives in `.tent/.git`. ETag checks protect document updates, and incomplete CLI reads cannot be used to replace a document.

## Install

Node.js 22.19+ and Git are required.

For Codex, download and extract `tent-plugin-0.1.0.zip`. Keep the extracted `.agents/` and `plugins/` directories together, then run:

```sh
codex plugin marketplace add "<absolute path to the extracted folder>"
codex plugin add tent@tent-local
```

Review the SessionStart and Stop Hooks in Codex before enabling them. Tent's CLI works without Hooks.

For the standalone npm CLI, download `cucarol-tent-0.1.0.tgz` and run:

```sh
npm install -g "<path to cucarol-tent-0.1.0.tgz>"
tent --help
```

This installs the CLI and its dependencies, but does not register a Codex plugin. See the [English README](https://github.com/cucarol/tent/blob/main/README.md) or [中文说明](https://github.com/cucarol/tent/blob/main/README.zh-CN.md) for usage and source builds.

## Current limits

There is no evidence yet that Tent improves on ordinary notes. In the first small Codex study, agents did not choose to use it when it was optional. A second study explicitly used Nodes and Roles but stopped at its session and token limits before completing cross-direction integration; its conclusion is insufficient evidence of a quality or efficiency benefit.

The format and commands are still early. This is a replacement distribution, not an upgrade for Obsidian; the old Obsidian release files are no longer the current install path.

The public repository starts from a clean root containing the current product. Earlier product history is retained locally by the maintainer rather than included in this release.
