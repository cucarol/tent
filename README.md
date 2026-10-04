# Tent / 帷幄

> *vibe 于帷幄之中*

[中文](README.zh-CN.md)

Tent keeps a project's working context inside the project: the goals you confirmed, the decisions later work must follow, the evidence that something was done, and the inputs passed from one agent session to the next. It is a small graph of Markdown files in `.tent/`, versioned by its own Git history. Agents read and maintain it through Skills and a CLI. You browse and edit it in a local web page.

Version 0.1.1. Early, and changing; see [Status](#status).

## When it helps

Tent is for projects that outgrow a single handoff note: several directions at once, requirements that get revised or withdrawn, work that spans many sessions or several agents. For a small task, a plain notes file is simpler and works just as well. Use that.

Installing Tent alone does not make an agent use it. Ask for it: "use Tent", "record this as a Node", "send a Card to the reporting Role".

## The model

Everything lives in `.tent/` at the root of a project folder. Your real files stay where they are; Tent points at them.

- **Node**: one durable fact, as Markdown with YAML frontmatter. Its `type` says what it rests on: `goal` for intent the user confirmed, `prompt` for agreements later work follows, `output` for evidence observed at a point in time. A project may add a suffix, in `primary[-secondary]` form, such as `prompt-decision`.
- **Role**: a continuing direction, with its purpose, boundaries and useful entry points. It is not a running agent, a permission or a model setting.
- **Card**: one fixed input. A prompt, the Nodes and files it rests on (Tent pins the Nodes and Roles to their Git versions), and optionally a target Role. A session takes a Card to record that it received it. To change an input, send a new Card.

Writes check an ETag, so two sessions cannot silently overwrite each other. Tent's history lives in `.tent/.git`, apart from your project's repository; `tent new` only adds `.tent/` to the project's `.gitignore`. The exact rules are in [docs/SPEC.md](docs/SPEC.md).

## Install

You need Node.js 22.19+ and Git.

### Codex

Download `tent-plugin-0.1.1.zip` from [Releases](https://github.com/cucarol/tent/releases/tag/0.1.1) and extract it to a folder you will keep. Add that folder as a local marketplace:

```sh
codex plugin marketplace add "<absolute path to the extracted folder>"
codex plugin add tent@tent-local
```

The extracted folder must contain both `.agents/` and `plugins/`. It includes the CLI, web UI, Skills and Hooks; no npm install is needed for this package.

To build from source instead:

```sh
git clone https://github.com/cucarol/tent.git
cd tent
npm ci --ignore-scripts
npm run plugin:build
codex plugin marketplace add "$PWD/release"
codex plugin add tent@tent-local
```

`npm run plugin:build` writes the complete plugin to `release/plugins/tent`: four Skills, two Hooks, the CLI and the web UI. It also writes a local marketplace next to it. Codex asks you to review the SessionStart and Stop Hooks; Tent works without them. Details: [docs/PLUGIN.md](docs/PLUGIN.md).

Or give your agent this:

```text
Install the Tent plugin for Codex from github.com/cucarol/tent:
clone it, run `npm ci --ignore-scripts && npm run plugin:build`,
then `codex plugin marketplace add "<clone>/release"` and `codex plugin add tent@tent-local`.
Check that the four Skills appear, and let me review the new Hooks.
```

### Other agents

Codex is the only host with a package so far. Any agent that can run shell commands can use the bundled CLI directly:

```sh
node "<plugin folder>/cli.mjs" --help
```

The plugin folder is `plugins/tent` inside the extracted download, or `release/plugins/tent` after a source build. To install only the CLI, run `npm install -g vibe-tent` (the same package is attached to the Release as `vibe-tent-0.1.1.tgz`). This exposes `tent`; it does not register a Codex plugin.

## Use

In the examples, `tent` is short for `node <plugin>/cli.mjs`. Agents find their own copy.

1. **Start**: ask your agent to set up Tent in a project folder, or run `tent new .`. This creates an empty `.tent/`. Tent does not scan the project or write Nodes for you.
2. **Keep facts**: while you work, have the agent record what later sessions must not get wrong (a confirmed goal, a decision and its reason, what a test actually showed), and read the relevant Nodes before it starts.
3. **Hand off**: when work moves to another session or direction, create a Card with the prompt and the Nodes it depends on. The next session takes it and starts from there.

Most work needs no Role and no Card. Commits, reviews and merges stay in your normal Git workflow.

## Web UI

```sh
tent ui --workspace <project folder>
```

A local page with the map of Nodes, Roles and Cards and how they connect. You can edit Nodes, create Cards, leave notes on the map, and switch between workspaces you have opened. It runs in the terminal you started it from; Ctrl+C stops it. `--port` picks a port, and `--no-open` prints the address without opening a browser.

## Status

- **One maintainer, version 0.1.1.** The file format and commands may still change; [SPEC](docs/SPEC.md) is the contract.
- **No evidence yet that it beats plain notes.** In the latest October 2026 comparison on a project with changing requirements, Markdown completed integration; Tent's initial decomposition timed out and its final integration was cut short by the shared token budget. A stale Tent summary was corrected in the next stage, while higher observed decomposition cost recurred; these local findings do not establish a quality or efficiency benefit.
- **Hooks need host approval.** The first test's Hooks were untrusted, so their absence does not show that the host mode cannot deliver them. Review and trust Hooks in the host if you want to enable them; every command works without them.

## Development

```sh
npm ci
npm run build
npm run test:fast
npm run ui:dev -- --workspace <project folder>
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)

## Friends

[Linux DO](https://linux.do): an open community for developers and tech enthusiasts.
