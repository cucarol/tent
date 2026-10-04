# Tent 0.1.1

Tent is a local Markdown context graph for coding agents, with a CLI, four Skills, two optional Hooks, and a local web UI.

- Nodes hold durable facts and decisions, Roles describe continuing work directions, and Cards preserve one input with pinned context references.
- The web UI can browse and edit the graph, create Cards, annotate the map, and switch workspaces.
- Context history lives in `.tent/.git`. ETag checks protect document updates, and incomplete CLI reads cannot be used to replace a document.

## Changes since 0.1.0

- The project is now named Tent. The repository is [cucarol/tent](https://github.com/cucarol/tent); old `vibe-tent` links redirect.
- The npm package `vibe-tent` now carries this product, so `npm install -g vibe-tent` works. The earlier `vibe-tent@0.1.0` on npm was the Obsidian plugin and is deprecated.
- Path checks treat `\` as a separator on every platform, so escaping paths are rejected on Linux and macOS as on Windows.
- Creating a Tent on Windows retries a directory rename that antivirus or indexing briefly blocks.

## Install

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

## Current limits

There is no evidence yet that Tent improves on ordinary notes; the README's Status section describes the studies so far. The format and commands are still early. This is a replacement distribution, not an upgrade for the old Obsidian plugin.

The public repository starts from a clean root containing the current product. Earlier product history is retained locally by the maintainer.
