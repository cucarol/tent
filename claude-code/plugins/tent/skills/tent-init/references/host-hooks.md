# Claude Code Hooks

| When | Do | Read |
| --- | --- | --- |
| Install or update | The user installs Tent with `/plugin`; its Hooks turn on with it | `/hooks`: Tent's SessionStart and Stop |
| Verify SessionStart | Start a new session | `Tent Workspace:` line |
| Verify Stop | Edit a module's file in a real turn | `Tent turn review` message |
| Stop names a Node | `tent node check <node-id>`, then tent-node | `state`, `reasons` |
