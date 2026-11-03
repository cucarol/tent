# Tent / 帷幄

[中文](README.zh-CN.md)

**A context graph for your project: what you decided, and what came of it.**

Your files hold the work. Tent keeps what they cannot: your goals, the prompts you give, and the outputs that come of them, each beside the part of the project it belongs to. Code, a novel or a video works the same way. Your agents read it before they start and update it as they work.

You decide, agents do the work, and Tent keeps the record. It works with Claude Code and Codex and stays on your machine as plain Markdown.

## Quick start

1. **Install the plugin** for Claude Code or Codex ([Install](#install)).
2. **In your project, tell your agent:**

   ```text
   Set up Tent for this project.
   ```

   The agent maps the project into Nodes, one per part of it, such as a module, a chapter or a folder of footage. Each Node covers that part's files and records what a change must keep, what else changes with it, and how to check it. A project you are halfway through can join this way.

3. **Read it.** Each Node is a Markdown file under `.tent/`, nested under its parent. Open them in any editor.

## What Tent keeps

Everything lives in `.tent/` at the project root, as Markdown files with independent SQLite history in `.tent/.git/history.sqlite`. Tent changes no project file: `.tent/` carries its own `.gitignore`, so Git ignores it without any change to your repository's settings.

- **Node**: one durable fact. Its `type` is exactly `goal`, `prompt` or `output`: what the work is for, what is given to get there, and what came out. It may cover the files it is about, or none. `tags` such as `decision` or `issue` say what form the content takes. They change no behavior.
- **Role**: a continuing direction of work, with its purpose and boundaries. Several sessions can work as the same Role.
- **Card**: one handoff to a Role. It carries the task and points to the Nodes and files it needs. When it names a Role to return to, the result comes back to that Role.

Most work needs no Role and no Card.

## What Tent tells you

- **Before a change**, the agent can run `tent load <files>`. Tent lists the Nodes covering those files, then the prompts under them and under every goal above them, so the agent starts from what the work is for and what it has to follow.
- **At the end of a turn** that changed files, Tent lists the Nodes covering them, with their types. The agent corrects each against what it records: a goal against what you want now, a prompt against the decisions made, an output against the workspace. It records what the turn settled, or says nothing. If no Node covers the changed files, Tent reminds it once to record what is worth keeping. When a goal changes, Tent names it, so the agent tells you.

Tent maps code, prose, data and assets alike. Parts follow folders, file names and what changes together in Git history; images, audio, video and fonts stay with their folder and do not count toward a part's size. For code, dependencies between parts also come from imports in TypeScript, JavaScript, Python, Go, Rust, Java, C#, C, C++ and PHP.

## Install

You need Node.js 22.19+ and Git. Tent works inside a Git repository and runs `git init` in a folder that is not one yet. Workspaces still on private-Git history need the one-shot [migration](docs/MIGRATION.md) on an offline copy. Workspaces from 0.2.0 then run two cleanups after upgrading, for the [map layout](docs/MIGRATION.md#map-layout-from-020) and for [retired Node metadata](docs/MIGRATION.md#remove-retired-node-metadata); where there is nothing to remove they change nothing.

**Claude Code:**

```sh
claude plugin install tent --marketplace "https://github.com/cucarol/tent.git#plugin-dist"
```

If your Claude Code has no `--marketplace` option, run `claude plugin marketplace add "https://github.com/cucarol/tent.git#plugin-dist"`, then `claude plugin install tent@tent`.

**Codex:**

```sh
codex plugin marketplace add cucarol/tent --ref plugin-dist && codex plugin add tent@tent
```

Each plugin bundles four Skills, a Stop Hook and the CLI; it needs no npm install. Claude Code turns the Hook on with the plugin. Codex asks you to review it. Every command works without it. Details: [docs/PLUGIN.md](docs/PLUGIN.md).

Or give your agent this:

```text
Install the Tent plugin. In Claude Code run
claude plugin install tent --marketplace "https://github.com/cucarol/tent.git#plugin-dist"
In Codex run
codex plugin marketplace add cucarol/tent --ref plugin-dist && codex plugin add tent@tent
Check that the four Tent Skills appear and that the Hooks are enabled.
```

Prebuilt packages are attached to each [release](https://github.com/cucarol/tent/releases/latest). For the CLI alone, `npm install -g vibe-tent` gives you the `tent` command.

### From source

```sh
git clone https://github.com/cucarol/tent.git
cd tent
npm ci --ignore-scripts
npm run plugin:build
```

Then, from the clone, run `claude plugin marketplace add "$PWD/release/claude-code"` and `claude plugin install tent@tent-local` for Claude Code, or `codex plugin marketplace add "$PWD/release/codex"` and `codex plugin add tent@tent-local` for Codex.

## The CLI by hand

Agents run these commands through the Skills; you rarely need to. `tent` is the npm command; with a plugin, the agent runs the bundled `cli.mjs`.

`tent --help` lists them; the exact rules are in [docs/SPEC.md](docs/SPEC.md).

## Status

Tent 0.x has one maintainer. The file format and commands may still change; [docs/SPEC.md](docs/SPEC.md) is the contract.

## Development

```sh
npm ci
npm run build
npm run test:fast
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

Report vulnerabilities privately, as [SECURITY.md](SECURITY.md) describes. Do not open a public issue.

## License

[MIT](LICENSE)

## Friends

[Linux DO](https://linux.do): an open community for developers and tech enthusiasts.
