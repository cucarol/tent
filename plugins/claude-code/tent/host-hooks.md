# Claude Code Hooks

| When | Do | Read |
| --- | --- | --- |
| Install or update | The user installs Tent with `/plugin`; its Hooks turn on with it | `/hooks`: Tent's SessionStart and PostToolUse |
| Verify SessionStart | Start a new session | `Tent Workspace:` line |
| Verify PostToolUse | Successfully edit a module's file in a real turn | `Tent: these Nodes cover` in the next model request |
| A tool names a Node | Read its file and maintain it when needed | Changed sentence or one short section |
