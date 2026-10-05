# Codex Hooks

The Tent plugin provides two Codex Hooks. Install or update them with the
whole plugin through the host; there are no separate global Hook scripts.

- **SessionStart** says that a Tent Workspace exists, where its CLI is, which
  build it uses, and how to request `workspace brief`. It reports a commit
  mismatch in a Tent source checkout and injects no Node bodies.
- **Stop** runs in the background. It records which files the turn provided,
  read or wrote, with their local versions but no contents, and asks at most
  three concrete questions about unrecorded outputs, changed evidence or new
  decisions. It never blocks the turn or starts another one.

## Set up and verify

1. Inspect the host's `/hooks` view for each Hook's source, command, enabled
   state and trust status.
2. New or changed Hooks need the host's own trust review: let the user approve
   them, never write trust hashes yourself, and respect Hooks the user
   disabled.
3. Report "configured, waiting for reload" separately from "observed running";
   only a real host event shows delivery.
4. If the host cannot run Stop in the background, leave Stop disabled and rely
   on SessionStart and the CLI.

## Stop questions

A Stop question asks for your judgment, not an automatic save. Inspect with
`node check`, then confirm, correct or link an output as
[tent-node](../../tent-node/SKILL.md) describes. Repeated observations of the
same file version do not repeat a question.

Official contract: [Codex Hooks](https://learn.chatgpt.com/docs/hooks).
