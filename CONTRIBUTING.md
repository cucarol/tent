# Contributing

Thanks for helping improve Tent.

## Ground Rules

- Put behavioral and permission rules in `src/core/`.
- Keep the CLI as a thin entrypoint to Core and filesystem helpers.
- Keep Node, Role and Card behavior in Core and SPEC.
- Keep context documents outside operational directories such as `temp/`.
- Keep changes scoped and add tests for observable behavior.

## Development Workflow

```bash
npm ci
npm run typecheck
npm run test:fast
```

### Repository layout

| Path | Purpose |
| --- | --- |
| `src/core/` | Domain rules and authority semantics |
| `src/fs/` | Filesystem, Git, locking and read-only historical data |
| `src/cli/` | Thin public CLI client |
| `skills/` | Published Tent Skills |
| `test/` | Source-level and contract tests |
| `docs/` | Specifications and plugin delivery guide |

### Test entry points

`npm test` is the **full regression gate** for the current product: it auto-discovers `test/**/*.test.ts` via `scripts/run-tests.ts`. Live e2e files (`*.e2e.ts`) stay opt-in.

| Script | Meaning |
| --- | --- |
| `npm test` / `npm run test` | **full** — every current `*.test.ts` once (used by `check` / `prepack`) |
| `npm run test:fast` | **fast** — focused unit and contract suites for the daily loop |
| `npm run test:integration` | **integration** — real Git, subprocess, recovery and packaging suites listed in `scripts/run-tests.ts` |

New current-product `*.test.ts` files are included in **full** and **fast** by default. Move a suite to the integration list when it exercises a slower real Git, process, recovery or packaging path. The two tiers do not overlap and together cover **full**. Use directly relevant tests for narrow changes and `test:fast` for a phase regression. `npm run check` is the release gate; do not repeat the full suite merely for reassurance.

List selected files without running: `node --import tsx scripts/run-tests.ts full --list` (also `fast` / `integration`).

Generated `cli.mjs` is intentionally ignored. `npm run build` recreates it before package tests or packaging. `npm run plugin:build` creates a new complete plugin directory without overwriting an existing delivery.

Pull requests should explain the behavior change, tests added, and any compatibility impact on existing Tent directories.

## Design Changes

Changes to the data model, lifecycle actions, or manifest contracts should start as a design note or issue discussion. Implementation should follow an explicit decision rather than silently redefining the format in a frontend.

Edit release versions only in `package.json`. Root and plugin builds generate the matching version in the delivery manifests; do not maintain those version fields by hand.

Run `npm run format` for source, test and build scripts; `npm run format:check` verifies their shared 100-column Prettier configuration. Source filenames use kebab-case.
