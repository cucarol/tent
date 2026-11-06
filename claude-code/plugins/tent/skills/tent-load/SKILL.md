---
name: tent-load
description: "Loads what Tent holds about part of this project before you change it: the goals it serves, the prompts to follow and the outputs that describe it. Use before changing files you have not worked on in this session, or when you need to know why something is the way it is."
---

# Tent Load

Tent keeps the context of this project's agent sessions as a graph of Markdown Nodes in `.tent/`. Each Node records one real thing, and that thing is its source:

| type | Records | Its source |
| --- | --- | --- |
| `goal` | What the work is for: an intention it is committed to | What the user wants now |
| `prompt` | What is given to get there: requirements, constraints, decisions and their reasons, references, ways of working | The decisions made |
| `output` | What came out, as it is now: results, findings, known problems | The workspace, or what was found |

A prompt or output sits under the goal it serves.

| When | Do |
| --- | --- |
| Before changing files | `tent load <path>...`, then read the Nodes it lists with your own tools |
| Asking why something is the way it is | `tent load <path>`, or search `.tent/` for the words |

`tent load` lists the Nodes covering those paths, then the prompts directly under them and under every goal above them, nearest first. Run `tent` as [access](../../skill-resources/references/access.md) shows.

Take Nodes as this project's facts: work toward its goals, follow its prompts, and treat its outputs as what exists. Where what you see or what the user says now differs, that wins; the Node gets corrected at the end of the turn.
