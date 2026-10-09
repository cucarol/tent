# Tent / 帷幄

[中文](README.zh-CN.md)

**A context graph for your project: what you decided, what got built, and what has drifted.**

Tent is a project's context graph, the counterpart of a code graph. A code graph maps how the code fits together. Tent records what happened and why: the goals the user confirmed, the agreements later work follows, and the evidence of what was built. It shows what is ahead: goals that nothing implements yet. It shows what is behind: facts whose material has changed since they were recorded. It is not a notebook and not a task board. Agents read and maintain it through Skills and a CLI. You browse it in a local web page.

## When it helps

Tent is for projects that outgrow a single handoff note: several directions at once, requirements that get revised, work across many sessions or agents. For a small task, a plain notes file is simpler and works as well.

## The model

Everything lives in `.tent/` at the project root. The folder that holds `.tent/` is the workspace. `.tent/` keeps its own Git history in `.tent/.git`, apart from your repository. Your files stay where they are; Tent points at them. `tent new` changes one thing outside `.tent/`: it adds `.tent/` to the project's `.gitignore`.

- **Node**: one durable fact, as Markdown with YAML frontmatter. Its `type` is exactly `goal`, `prompt` or `output`, and says what the content rests on:
  - `goal`: intent the user confirmed.
  - `prompt`: an agreement later work follows.
  - `output`: evidence observed at a point in time.

  `tags` say what form the content takes and what it is about. They are free text and change no behavior. Tent suggests presets such as `decision` and `evidence`.
- **Role**: a continuing direction, with its purpose, boundaries and entry points. It is not a running agent or a permission.
- **Card**: one fixed input. It holds a prompt, its sources and an optional target Role. Node and Role sources are pinned to their Git versions. A session takes a Card to record that it received it. A Card never changes after it is sent; to change the input, send a new Card.

Two findings come from comparing the graph with your files. A Node is **behind** when its material, a file or Node it points to, has changed since Tent recorded its version. A goal is **ahead** when no active output, one that is not deprecated, exists anywhere under it; tags do not change this. A goal is also ahead after it changes: when its text or material changes, every output under it goes behind, and the goal stays ahead until they are reviewed. When only an output's own material changes, that output goes behind but its goal is not ahead: the work exists and needs review. A Card counts a goal as done only through an output that is not behind; with a behind output it shows `needs-review`.

File paths you give the CLI as material, such as `--resource` or a Card `--source`, resolve from the workspace root. A write that replaces content must present the ETag it read, so two sessions cannot silently overwrite each other. The exact rules are in [docs/SPEC.md](docs/SPEC.md).

## Install

You need Node.js 22.19+ and Git.

### Codex

Download `tent-plugin-<version>.zip` from the [latest release](https://github.com/cucarol/tent/releases/latest). Extract it to a folder you will keep; it holds `.agents/` and `plugins/`. Add that folder as a local marketplace and install the plugin:

```sh
codex plugin marketplace add "<absolute path to the extracted folder>"
codex plugin add tent@tent-local
```

The plugin bundles four Skills, two Hooks, the CLI and the web UI. It needs no npm install. Codex asks you to review the SessionStart and Stop Hooks; every command works without them. Details: [docs/PLUGIN.md](docs/PLUGIN.md).

To build from source:

```sh
git clone https://github.com/cucarol/tent.git
cd tent
npm ci --ignore-scripts
npm run plugin:build
codex plugin marketplace add "$PWD/release"
codex plugin add tent@tent-local
```

`npm run plugin:build` writes the plugin to `release/plugins/tent` and a local marketplace next to it. It refuses to overwrite an existing build.

Or give your agent this:

```text
Install the Tent plugin for Codex from github.com/cucarol/tent:
clone it, run `npm ci --ignore-scripts && npm run plugin:build`,
then `codex plugin marketplace add "<clone>/release"` and `codex plugin add tent@tent-local`.
Check that the four Skills appear, and let me review the new Hooks.
```

### Other agents

Codex is the only host with a plugin package. Any agent that runs shell commands can use the bundled CLI:

```sh
node "<plugin folder>/cli.mjs" --help
```

The plugin folder is `plugins/tent` in the extracted download, or `release/plugins/tent` after a source build. To install only the CLI, run `npm install -g vibe-tent`. This gives you the `tent` command; it does not register a Codex plugin. Each release also carries the same package as `vibe-tent-<version>.tgz`.

## Use

`tent` below is the npm command; with the plugin, run `node "<plugin folder>/cli.mjs"` instead. Each command prints the id the next one needs. `<goal-id>`, `<card-id>`, `<output-id>` and `<etag>` stand for those values.

1. **Create a Tent.** In the project root, this creates an empty `.tent/` with its own Git history.

   ```sh
   tent new .
   ```

2. **Record a goal.** The brief lists it as ahead: nothing implements it yet.

   ```sh
   tent node create "Email sign-in" --type goal --body "Users sign in with an email address and a one-time code."
   tent workspace brief
   ```

3. **Send a Card.** The Card carries the prompt and pins the goal at its current version.

   ```sh
   tent card create --prompt "Implement email sign-in." --source <goal-id>
   ```

4. **Take it.** The session that does the work takes the Card, and Tent records the reception.

   ```sh
   tent card take <card-id>
   ```

5. **Link an output.** Once the work exists as a file, the output records it under the goal and answers the Card.

   ```sh
   echo "export function signIn(email) {}" > login.js
   tent node link-output <goal-id> --resource login.js --card <card-id>
   ```

6. **Change the material.** The brief now lists the output as behind and the Card as `needs-review`.

   ```sh
   echo "export const CODE_TTL_MINUTES = 10;" >> login.js
   tent workspace brief
   ```

7. **Confirm.** After reviewing the change, confirm the output with the `etag` from a full read.

   ```sh
   tent node get <output-id> --full --json
   tent node confirm <output-id> --base-etag <etag>
   ```

`tent workspace brief` now reports `behind 0 · ahead 0`.

In daily work your agent runs these commands through the Skills when you ask: "use Tent", "record this as a goal", "send a Card to the reporting Role". Most work needs no Role and no Card. Commits, reviews and merges stay in your Git workflow.

## Web UI

```sh
tent ui --workspace <project folder>
```

The server runs in this terminal; Ctrl+C stops it. The page opens on Now: Role work from Cards, outputs since your last visit, and what is ahead or behind. The map shows Nodes, Roles and Cards and how they link, with the same marks. You can edit and confirm Nodes, write Cards, and switch between workspaces you have opened. `--port` picks the port. `--no-open` prints the address without opening a browser.

## Status

- **One maintainer.** The file format and commands may still change. [docs/SPEC.md](docs/SPEC.md) is the contract.
- **No evidence yet that it beats plain notes.** The latest comparison ran in October 2026 on a project with changing requirements. The Markdown group completed integration. Tent's initial decomposition timed out, and the shared token budget cut its final integration short. A stale Tent summary was corrected in the next stage. Higher decomposition cost showed up again. These local findings do not establish a quality or efficiency benefit.
- **Hooks need host approval.** In the first test the Hooks were untrusted, so their absence there does not show that the host cannot deliver them. Review and trust them in the host to enable them. Every command works without them.

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
