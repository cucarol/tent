# Node types and tags

Every Node has one `type` and any number of `tags`:

- the **type** says what the content rests on, and so how to treat it. Tent
  uses exactly three: `goal`, `prompt` or `output`;
- **tags** say what form the content takes and what it is about. `tags` is
  the native cross-cutting field of OKF v0.2 §4.1; in Tent they are free
  text and change no behavior.

## Type

| Type | Holds | Rests on | How to use it |
| --- | --- | --- | --- |
| `goal` | What the user wants, and why | The user's confirmation | Work toward it. Change it only when the user decides; when your work conflicts with it, stop and ask. |
| `prompt` | What later work should follow | An agreement | Follow it. When reality contradicts it, say so and propose an update instead of quietly diverging. |
| `output` | What exists or happened | Evidence from a point in time | Check the referenced material before relying on it. |

To classify content, ask what it rests on: the user's intent, an agreement to
follow, or evidence from some time. Your own conclusions are `output` until
the user agrees to them.

Any current `output` under a goal counts as its result, whatever its tags, and
an output whose sources name a Card answers that Card. The goal is no longer
ahead once such an output exists, except while its outputs are behind because
the goal itself changed; an output behind only because its own material
changed does not make the goal ahead. Keep a goal's open questions, research
and pending decisions in `prompt` Nodes until they produce a result.

Change the type with `tent node type <node-id> goal|prompt|output --base-etag <etag>`;
the id stays.

## Tags

Tags name the form (a decision, a spec, evidence) and the topic (`ui`,
`release`) at once. Before tagging, run `tent node tags` to see the tags in
use with their counts. Reuse one of those or a preset below; do not invent a
synonym for a tag that already exists.

| Preset | Usually on | Use |
| --- | --- | --- |
| `direction` | `goal` | A broad direction to break into concrete requirements. |
| `requirement` | `goal` | A specific result; attach its output when it is done. |
| `decision` | `prompt` | An agreed choice or rule, with its reasons; follow it. |
| `spec` | `prompt` | How an area works. Link to the relevant SPEC or code section for the rules; keep only reasons and tradeoffs here instead of repeating them. |
| `reference` | `prompt` | Background and research to consult when needed. |
| `procedure` | `prompt` | Steps to carry out. |
| `asset` | `output` | A delivered file, such as code, a design, HTML or an image. |
| `evidence` | `output` | Verification: what was checked and what the results were. |
| `analysis` | `output` | Conclusions from measurement, evaluation or research. |
| `issue` | `output` | A known problem. |

Add tags with `--tags a,b` on `node create` or `node link-output`, or later
with `tent node tags set|add|remove <node-id> <tag,...> --base-etag <etag>`.
`tent node list --type output --tag evidence` finds matching Nodes; repeated
`--tag` flags must all match.

A Node takes the type of its main content. When one part will be read or
revised on its own, move it into a child Node with its own type and tags.
