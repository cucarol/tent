# Codex Hooks

The Tent plugin provides two Codex Hooks. Install or update the whole plugin
through the host; it does not add separate global Hook scripts. Hosts without
these Hooks use the bundled CLI directly.

- **SessionStart** tells the conversation that a Tent Workspace exists,
  where its CLI is and which build it uses. It reports a commit mismatch in
  a Tent source checkout. It reads no Node or Role bodies and selects nothing.
- **Stop** runs after a turn and reads the end of that turn's transcript. When
  the turn changed files that Nodes declare as material, it lists up to five
  of those Nodes, in at most 2 KiB, so the Agent can check them. Read-only and
  cancelled turns stay quiet; when it cannot tell which files changed, it says
  so. It never blocks the turn or starts another one.

## Set up and verify

1. Inspect native `/hooks` or the `hooks/list` interface for each Hook's
   source, command, enabled state and trust status.
2. New or changed Hook commands need the host's own trust review. Let the user
   approve them, and never write trust hashes yourself. Respect Hooks the user
   disabled.
3. Report "configured, waiting for reload" separately from "observed running".
   Only a real host event shows delivery; feeding JSON to the handler tests
   the handler alone.
4. The package requests `async: true` for Stop. If the installed host cannot
   run Stop in the background, leave Stop disabled and rely on SessionStart and
   the normal CLI.

## Reading Stop notices

A Stop notice is a pointer to Nodes worth checking, not a verdict. It may
appear in the interface or in a later turn. A current `node check` record for
the changed files suppresses a Node, and that says only that versions match.
Keeping facts current stays the Agent's job through
[tent-node](../../tent-node/SKILL.md). Automatic Card interruption is not
available yet; use explicit `card interrupt` and `card continue`.

Official event and output contract: [Codex Hooks](https://learn.chatgpt.com/docs/hooks).
