import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Skill 与程序同包时始终使用这一版本，不从 PATH 换用另一份 Tent。
const cli = new URL("../../cli.mjs", import.meta.url);
await access(cli);
process.argv[1] = fileURLToPath(cli);
await import(cli.href);
