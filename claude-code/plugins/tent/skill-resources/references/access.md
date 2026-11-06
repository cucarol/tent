# Run the CLI

`tent` stands for the CLI bundled with these Skills:

```text
node "<this Skill's directory>/../../skill-resources/scripts/tent.mjs" <command> <arguments>
```

- Run it inside the Workspace (the folder holding `.tent/`), or add `--workspace <root>`.
- Add `--json` to read the receipt fields named in a Read column.
- Pass multi-line text through stdin with `-`, as in `--body -` or `--prompt -`.
- In Git Bash, set `MSYS_NO_PATHCONV=1` so arguments that start with `/` stay intact.
- `tent <group> --help` lists exact arguments.
