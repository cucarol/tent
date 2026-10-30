# Codex Hooks

| When | Do | Read |
| --- | --- | --- |
| Install or update | The host's whole-plugin flow; Hooks the user disabled stay off | `/hooks`: source, command, enabled, trust |
| A Hook is new or changed | The user approves it in the host's trust review | `/hooks` trust status |
| Verify SessionStart | Start a real session | `Tent Workspace:` line |
| Verify PostToolUse | Successfully edit a module's file in a real turn | `Tent: these Nodes cover` in the next model request |
| Verify turn completion | Change a covered Git file during a real turn | One `Tent: these Nodes cover files changed during this turn:` continuation if its Node was not already named |
| A tool names a Node | Read its file and maintain it when needed | Changed sentence or one short section |
