# Tent / 帷幄

[中文](README.zh-CN.md)

**A context graph for your project: what you decided, what got built.**

A code graph shows how the code fits together. Tent keeps what the code cannot hold: your goals, the prompts you give, and the outputs that come of them. Your agents read it before they start and update it as they work.

You decide, agents do the work, and Tent keeps the record. It works with Claude Code and Codex and stays on your machine as plain Markdown.

## Quick start

1. **Install the plugin** for Claude Code or Codex ([Install](#install)).
2. **In your project, tell your agent:**

   ```text
   Set up Tent for this project.
   ```

   The agent maps the existing code into Nodes, one per part of the project. Each Node owns that part's code and records the rules a change must keep, what else changes with it, and how to verify it. A project you are halfway through can join this way.

3. **Read it.** Each Node is a Markdown file under `.tent/`, nested under its parent. Open them in any editor.

## What Tent keeps

Everything lives in `.tent/` at the project root, as Markdown files with independent SQLite history in `.tent/.git/history.sqlite`. Tent changes no project file: it adds `.tent/` to Git's local exclude list (`.git/info/exclude`), not to your `.gitignore`.

- **Node**: one durable fact. Its `type` is exactly `goal`, `prompt` or `output`. `tags` such as `decision` or `issue` say what form the content takes. They change no behavior.
- **Role**: a continuing direction of work, with its purpose and boundaries. Several sessions can work as the same Role.
- **Card**: one handoff. It carries a short prompt and pins the Nodes it points to. When it names a Role to return to, the result comes back to that Role.

Most work needs no Role and no Card.

## What Tent tells you

- **At the end of a turn** that changed files, Tent names the Nodes covering them. The agent fixes any sentence the turn made wrong, records what is worth keeping, or says nothing needs recording.

Dependencies between parts come from imports in TypeScript, JavaScript, Python, Go, Rust, Java, C#, C, C++ and PHP. Code in other languages is still mapped by directory and by what changes together in Git history.

## Install

You need Node.js 22.19+. Git enables project-repository observations, the existing per-directory ignore interpretation and local-exclude initialization step; SQLite history itself does not require Git. Existing private-Git workspaces need the one-shot [migration](docs/MIGRATION.md) on an offline copy. Workspaces from 0.2.0 run one [cleanup script](docs/MIGRATION.md#map-layout-from-020) after upgrading; where the map was never used it changes nothing.

**Claude Code:**

```sh
claude plugin install tent --marketplace "https://github.com/cucarol/tent.git#plugin-dist"
```

If your Claude Code has no `--marketplace` option, run `claude plugin marketplace add "https://github.com/cucarol/tent.git#plugin-dist"`, then `claude plugin install tent@tent`.

**Codex:**

```sh
codex plugin marketplace add cucarol/tent --ref plugin-dist && codex plugin add tent@tent
```

Each plugin bundles four Skills, Stop Hooks and the CLI; it needs no npm install. Claude Code turns the Hooks on with the plugin. Codex asks you to review them. Every command works without them. Details: [docs/PLUGIN.md](docs/PLUGIN.md).

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

Writes that replace content must present the ETag they read, so two sessions cannot silently overwrite each other. The exact rules are in [docs/SPEC.md](docs/SPEC.md).

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
