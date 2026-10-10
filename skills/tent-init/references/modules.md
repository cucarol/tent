# Map an existing project

Give the code a tree of module Nodes. Tent supplies facts; you choose the modules.

1. Run `tent workspace scan`. Its four parts count uncovered tracked files by parent directory (top 15; a directory may be partly covered), files that change together (then hub files), the busiest directories, and Markdown no Node points to. `--json` has the full lists: `coverage.directories`, `cochange.groups[].files`, `cochange.hubs`, `hotspots` and `unpointedDocuments`; take every gap from `coverage.directories`. Read the README and top-level layout too. If `graphify-out/GRAPH_REPORT.md` exists, use its communities as a hint.
2. Draft the modules. The first level has 5 to 12. Split a module again only where its directory is large or has separate busy parts; keep the total under 40. Files that change together belong to one module; hub files belong to none. A module may span directories, such as its source and its tests.
3. Each module is a `prompt` tagged `spec`, under one `prompt` that holds the map, or under its parent module. Its `resource` is its main directory, ending in `/`; other directories go in `sources`. Without a real directory there is no module, except one setup module for root files and small tool directories such as `.github/`: no `resource`, those as `sources`, never `./`. The body says what the module is for, what lies outside it, its entry points and what it depends on, as found in code or docs, and links the docs that describe it, including Markdown the scan listed. Do not list other files; the directory covers them. The map's body lists the first-level modules, one line each: its link and what it is for.

   Body links are relative to the Node's own file, and a leading `/` means `.tent/`, not the Workspace. A module `Core` under `Map` lives at `.tent/Map/Core/Core.md`: it links the README as `../../../README.md`, and `Map` links it as `[Core](Core/Core.md)`.
4. Create all of them in one `tent node write-many --input-json -`, with items like `{"op":"create","ref":"core","parent":"@map","name":"Core","type":"prompt","tags":["spec"],"resource":"src/core/","sources":[{"resource":"test/core/"}],"body":"..."}`. On an error, fix only what it names; after two failed rounds, stop and ask the user.
5. Run `tent workspace scan --json` again. Show the user the module tree and each remaining gap with its reason, such as generated or vendored.

To fill gaps later, map only what `coverage.directories` lists and leave existing modules as they are.
