# Codex Hooks

| When | Do | Check |
| --- | --- | --- |
| Install / update | Use the host's whole-plugin flow | Inspect source, command, enabled state and trust in `/hooks` |
| New / changed Hook | Let the user complete host trust review | Never write trust hashes; preserve user-disabled Hooks |
| Verify SessionStart | Observe a real session start | Workspace, CLI, build identity and brief command |
| Verify Stop | Observe a real turn end | Background delivery when there is something to report |
| Host lacks background Stop | Leave Stop disabled | Use SessionStart and normal CLI |
| Stop asks about a Node | `tent node check <node-id>`, then follow [tent-node](../../tent-node/SKILL.md) | Review before confirming, correcting or linking output |

- Report configured/waiting for reload separately from observed running.
- Handwritten Hook input does not prove host delivery.
- Treat Stop questions as prompts for judgment, not automatic saves.
- Do not install separate global Hook scripts.

Maintainer background: [plugin guide](../../../docs/PLUGIN.md).
