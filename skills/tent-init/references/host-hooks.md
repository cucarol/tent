# Codex Hooks

| When | Do | Read |
| --- | --- | --- |
| Install or update | The host's whole-plugin flow; Hooks the user disabled stay off | `/hooks`: source, command, enabled, trust |
| A Hook is new or changed | The user approves it in the host's trust review | `/hooks` trust status |
| Verify SessionStart | Start a real session | `Tent Workspace:` line |
| Verify Stop | End a real turn that wrote a file | `Tent turn review:` message |
| The host has no background Stop | Leave Stop disabled | |
| Stop names a Node | `tent node check <node-id>`, then tent-node | `state`, `reasons` |
