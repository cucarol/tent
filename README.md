# Tent / 帷幄

[中文](README.zh-CN.md)

**A context graph for your project: what you decided, what got built, and what has gone stale.**

A code graph shows how the code fits together. Tent keeps what the code cannot hold: the goals you confirmed, the rules later work must follow, the options you rejected, and the evidence of what was built. Your agents read it before they start and update it as they work. When the code or a document changes under a recorded fact, Tent marks the fact as stale so it gets fixed instead of misleading the next session.

You decide, agents do the work, and Tent keeps the record. It works with Claude Code and Codex, stays on your machine, and you browse it as a map in a local web page.

## Quick start

1. **Install the plugin** for Claude Code or Codex ([Install](#install)).
2. **In your project, tell your agent:**

   ```text
   Set up Tent for this project.
   ```

   The agent maps the existing code into Nodes, one per part of the project. Each Node owns that part's code and records the rules a change must keep, what else changes with it, and how to verify it. A project you are halfway through can join this way.
3. **Open the map.** The agent finishes by starting the web page and giving you its address. Later, ask it to open the Tent map again.

## What Tent keeps

Everything lives in `.tent/` at the project root, as Markdown files with their own Git history in `.tent/.git`. Tent changes no project file: it adds `.tent/` to Git's local exclude list (`.git/info/exclude`), not to your `.gitignore`.

- **Node**: one durable fact. Its `type` is exactly `goal`, `prompt` or `output`, and says what the fact rests on:
  - `goal`: intent you confirmed, such as a feature or a part of the code.
  - `prompt`: a rule or agreement later work follows, a decision with its reasons, or a way of working.
  - `output`: a result, check or problem seen at one time.

  `tags` such as `decision` or `issue` say what form the content takes. They change no behavior.
- **Role**: a continuing direction of work, with its purpose and boundaries. Several sessions can work as the same Role.
- **Card**: one handoff. It carries a short prompt and pins the Nodes it points to. When it names a Role to return to, the result comes back to that Role.

Most work needs no Role and no Card.

## What Tent tells you

- **Behind**: a goal or rule whose material, the file or Node it points to, has changed or gone missing since it was recorded. The fact may be out of date.
- **Ahead**: a goal that nothing carries out yet, or that changed after its output. A goal that owns code counts as carried out by that code until you change the goal.
- **At the start of a session**, the agent reads a short summary: what is behind or ahead, and the Cards waiting for it.
- **At the end of a turn** that changed files, Tent names the Nodes covering them. The agent fixes any sentence the turn made wrong, records what is worth keeping, or says nothing needs recording.

Dependencies between parts come from imports in TypeScript, JavaScript, Python, Go, Rust, Java, C#, C, C++ and PHP. Code in other languages is still mapped by directory and by what changes together in Git history.

## The map

The web page shows Nodes as cards on one canvas, linked to their parents and to the parts they depend on. Behind and ahead are marked on the cards.

- Drop one card on another and they form a group. Tent states what it can check from facts it holds, for example whether an output still matches its goal or whether a rule's material changed after it was written. Whether the work is right is for an agent to judge.
- Roles sit in the top bar as a stack of avatars that opens into a list, with what each one is working on and waiting for. Drag cards onto the stack and drop them on a Role to write it a Card.
- Edit Nodes in place, and switch between the workspaces you have opened.

## Install

You need Node.js 22.19+ and Git. Build both plugins from source:

```sh
git clone https://github.com/cucarol/tent.git
cd tent
npm ci --ignore-scripts
npm run plugin:build
```

**Claude Code**, from the clone:

```sh
claude plugin marketplace add "$PWD/release/claude-code"
claude plugin install tent@tent-local
```

**Codex**, from the clone:

```sh
codex plugin marketplace add "$PWD/release/codex"
codex plugin add tent@tent-local
```

Each plugin bundles four Skills, a SessionStart and a Stop Hook, the CLI and the web page; it needs no npm install. Claude Code turns the Hooks on with the plugin. Codex asks you to review them. Every command works without them. Details: [docs/PLUGIN.md](docs/PLUGIN.md).

Or give your agent this:

```text
Install the Tent plugin from github.com/cucarol/tent: clone it, run
`npm ci --ignore-scripts && npm run plugin:build`, then add the marketplace
under release/claude-code (Claude Code) or release/codex (Codex) and install tent@tent-local.
Check that the four Tent Skills appear and that the Hooks are enabled.
```

Prebuilt packages are attached to each [release](https://github.com/cucarol/tent/releases/latest). For the CLI alone, `npm install -g vibe-tent` gives you the `tent` command.

## The CLI by hand

Agents run these commands through the Skills; you rarely need to. Below, `tent` is the npm command; with a plugin, the agent runs the bundled `cli.mjs`. Each command prints the id the next one needs.

```sh
tent new .
echo "export function signIn(email) {}" > login.js

# A goal: nothing carries it out yet, so the summary lists it as ahead.
tent node create "Email sign-in" --type goal --body "Users sign in with an email address and a one-time code."
tent workspace brief

# A rule under it, resting on login.js, and an output that records the work.
tent node create "One-time codes" --type prompt --parent <goal-id> --resource login.js --body "A code works once and expires after 10 minutes."
tent node link-output <goal-id> --resource login.js

# Change the code: the rule is now behind.
echo "export const CODE_TTL_MINUTES = 30;" >> login.js
tent workspace brief
```

Fix whichever is wrong, the rule or the code. Then confirm the rule with the `etag` from a full read, and the summary reports `behind 0 · ahead 0`:

```sh
tent node get <prompt-id> --full --json
tent node confirm <prompt-id> --base-etag <etag>
```

Writes that replace content must present the ETag they read, so two sessions cannot silently overwrite each other. The web page runs with `tent ui --workspace <project folder>`; Ctrl+C stops it. The exact rules are in [docs/SPEC.md](docs/SPEC.md).

## Status

Tent 0.x has one maintainer. The file format and commands may still change; [docs/SPEC.md](docs/SPEC.md) is the contract.

## Development

```sh
npm ci
npm run build
npm run test:fast
npm run ui:dev -- --workspace <project folder>
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

Report vulnerabilities privately, as [SECURITY.md](SECURITY.md) describes. Do not open a public issue.

## License

[MIT](LICENSE)

## Friends

[Linux DO](https://linux.do): an open community for developers and tech enthusiasts.
