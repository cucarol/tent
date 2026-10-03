# Referenced materials

A Node's `resource` names its main material and `sources` list related
material in order. Resolve each address as described in
[runtime access](access.md), then read the material with your usual file,
browser or application tools. Tent stores the address, not the content, and
has no format-specific readers.

A Node's `version` covers its own Markdown only, not the files it points to.
When you confirm a Node against its material, compare the bytes you actually
read and record the check with `tent node check`; see
[Node saving](node-maintenance.md#check-a-node-against-its-material). A
matching hash shows the file is unchanged, not that the Node's claims are
right.
