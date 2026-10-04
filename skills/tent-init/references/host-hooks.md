# Codex Hooks

The Tent plugin provides two Codex Hooks. Install or update the whole plugin
through the host; it does not add separate global Hook scripts. Hosts without
these Hooks use the bundled CLI directly.

- **SessionStart** tells the conversation that a Tent Workspace exists,
  where its CLI is, which build it uses and how to request `workspace brief`.
  It reports a commit mismatch in a Tent source checkout. It reads no Node
  or Role bodies and does not inject the brief itself.
- **Stop** reads the end of the current turn's transcript and records explicit
  provided/read/written file addresses, times and locally observed versions.
  It stores no material or conversation bodies. It asks at most three concrete
  questions with candidate answers about unlinked outputs, changed evidence
  or explicit new decisions; ordinary requests do not trigger an intent question,
  nor do turns that already changed a Node or Card. Questions use English and
  the complete JSON fits within 2 KiB. Duplicate Stop
  delivery is silent. Cancelled turns retain observed facts without questions.
  Incomplete observations stay marked uncertain. It never blocks the turn or
  starts another one.

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

A Stop question needs judgment and may appear in the interface or a later
turn. Repeated observations of the same file version in a session do not
repeat the question. Use `node check` to inspect, then confirm or update and
confirm the Node after reviewing its evidence; `node write --confirm` combines
the corrected save and confirmation. Use `node link-output` for an output's
requirement. A version match alone does not prove semantic correctness.
Keeping facts current stays the Agent's job through
[tent-node](../../tent-node/SKILL.md). Automatic Card interruption is not
available yet; use explicit `card interrupt` and `card continue`.

Official event and output contract: [Codex Hooks](https://learn.chatgpt.com/docs/hooks).
