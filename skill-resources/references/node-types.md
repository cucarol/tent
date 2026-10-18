# Node types and tags

The `type` says how to treat a Node; `tags` name its form and topic.

| Type | Holds | Treat it |
| --- | --- | --- |
| `goal` | What the user or the project intends, and why | Work toward it; change it only on the user's decision. |
| `prompt` | Rules, decisions, specs, open questions | Follow it; propose an update when reality contradicts it. |
| `output` | A result, check or problem seen at one time, such as a review verdict or a delivery record | Check its material first; your conclusions stay `output` until the user agrees. |

Any undeprecated `output` under a goal counts as its result, and a goal that owns code is carried out by that code; keep the goal's open questions in `prompt` Nodes. Leave commit ids, test counts and delivery status to Git and Cards.

A Node takes zero or more tags. Reuse one from `tent node tags` or a preset, and add the topic words the project uses:

| Tag | When the Node |
| --- | --- |
| `direction` | sets a broad aim to split into requirements |
| `requirement` | asks for one specific result |
| `decision` | records an agreed choice and its reasons |
| `spec` | explains an area and links its SPEC or code |
| `reference` | holds background to consult |
| `procedure` | lists steps to carry out |
| `asset` | points to a delivered file |
| `evidence` | records what was checked and the result |
| `analysis` | draws conclusions from measurements |
| `issue` | describes a known problem |

Pass `--tags a,b` to `node create` or `node link-output`. To change the type or tags later, edit them in the file's frontmatter.
