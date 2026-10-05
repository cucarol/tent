# Node types

A type is `primary` or `primary-suffix`. The primary type is `goal`, `prompt`
or `output` and tells the reader how to treat the content. The suffix is a
free label for its form; it adds no behavior.

| Type | Holds | Rests on | How to use it |
| --- | --- | --- | --- |
| `goal` | What the user wants, and why | The user's confirmation | Work toward it. Change it only when the user decides; when your work conflicts with it, stop and ask. |
| `prompt` | What later work should follow | An agreement | Follow it. When reality contradicts it, say so and propose an update instead of quietly diverging. |
| `output` | What exists or happened | Evidence from a point in time | Check the referenced material before relying on it. |

To classify content, ask what it rests on: the user's intent, an agreement to
follow, or evidence from some time. Your own conclusions are `output` until
the user agrees to them. Under a goal, though, an `output` counts as
implementing it, so keep that goal's open questions and research in `prompt`
Nodes. Change the type with `tent node type <node-id> <type> --base-etag <etag>`;
the id stays.

A Node takes the type of its main content. When one part will be read or
revised on its own, move it into a child Node with its own type.
