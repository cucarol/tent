# Claude Code Hooks

| When | Do | Read |
| --- | --- | --- |
| Install or update | The user installs Tent with `/plugin`; its Hooks turn on with it | `/hooks`: Tent's SessionStart, PostToolUse, UserPromptSubmit and Stop |
| Verify SessionStart | Start a new session | `Tent Workspace:` line |
| Verify PostToolUse | Successfully edit a module's file in a real turn | `Tent: these Nodes cover` in the next model request |
| Verify turn completion | Change a covered Git file during a real turn | One `Tent: these Nodes cover files changed during this turn:` continuation if its Node was not already named |
| A tool names a Node | Read its file and maintain it when needed | Changed sentence or one short section |
