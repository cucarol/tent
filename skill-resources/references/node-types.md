# Node types

A Node type is `primary` or `primary-secondary`. The primary type is always
`goal`, `prompt` or `output` and tells the reader how to treat the content.
The secondary suffix is a free label: its name says what form the content
takes, any non-empty text is valid, and it adds no behavior.

## Primary types

| Type | Holds | Rests on | How to use it |
| --- | --- | --- | --- |
| `goal` | What the user wants, and why | The user's confirmation | Work toward it. Change it only when the user decides; when your work conflicts with it, stop and ask. |
| `prompt` | What later work should follow | An agreement | Follow it. When reality contradicts it, say so and propose an update instead of quietly diverging. |
| `output` | What exists or happened | Evidence from a point in time | Check the referenced material before relying on it, and record what you checked and when. |

To classify content, ask what it rests on: the user's intent, an agreement to
follow, or evidence observed at some time. When that changes, change the
primary type with `tent node type <node-id> <type> --base-etag <etag>`; the
Node keeps its id. For example, your own conclusions are `output` until the
user agrees to them.

## Mixed content

A Node takes the type of its main content. When one part will be read or
revised on its own, such as the open questions inside a direction, move it
into a child Node with its own type.
