import { transactionResult } from "./transaction-result.js";
import { workspaceReadPaths } from "./read-paths.js";
import { captureNativeNodeEdits } from "../core/graph/node-native-capture.js";
import { parseArgs } from "node:util";
import { NodeFs } from "../fs/node-fs.js";
import { resolveWorkspacePaths } from "./workspace-path.js";
import { createRoleContext } from "../core/read/role-context.js";
import { deleteRole } from "../core/write/role-delete.js";
import { cliErrorText, unknownCommandError, type ErrorContext } from "./error-text.js";

const ROLE_COMMANDS = ["create", "delete"];

export type RoleCommandOptions = {
  workspace?: string;
  cwd?: string;
  json?: boolean;
  stdin?: string;
};
export type RoleCommandResult = { exitCode: number; stdout: string; stderr: string };

export async function runRoleCommand(
  sub: string,
  args: string[],
  globals: RoleCommandOptions = {},
): Promise<RoleCommandResult> {
  return transactionResult((opened) => runRoleCommandOpened(sub, args, globals, opened));
}

async function runRoleCommandOpened(
  sub: string,
  args: string[],
  globals: RoleCommandOptions,
  opened: (fs: NodeFs) => Promise<void>,
): Promise<RoleCommandResult> {
  const errorContext: ErrorContext = { workspace: globals.workspace };
  if (!sub || ["help", "--help", "-h"].includes(sub))
    return { exitCode: 0, stdout: roleHelpText(), stderr: "" };
  try {
    if (!ROLE_COMMANDS.includes(sub)) throw unknownCommandError("tent role", sub, ROLE_COMMANDS);
    const flags = ["workspace", ...(sub === "create" ? ["title", "body", "id"] : [])];
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        ...Object.fromEntries(flags.map((key) => [key, { type: "string" as const }])),
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (values.help) return { exitCode: 0, stdout: roleHelpText(), stderr: "" };
    const value = (key: string) => (values as Record<string, unknown>)[key] as string | undefined;
    errorContext.workspace = value("workspace") ?? globals.workspace;
    const selected = sub === "delete";
    if (positionals.length === 1 && selected)
      errorContext.target = { kind: "role", id: positionals[0]! };
    const text = async (key: string) => {
      const input = value(key);
      if (input !== "-") return input;
      if (globals.stdin !== undefined) return globals.stdin;
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString("utf8");
    };
    if (positionals.length !== (selected ? 1 : 0))
      throw new Error(
        selected ? "Usage: tent role delete <role-id>" : "tent role create takes no Role id",
      );
    if (sub === "create" && !value("title")?.trim())
      throw new Error("Role create requires --title");
    const { systemRoot, workspaceRoot } = await resolveWorkspacePaths({
      cwd: globals.cwd,
      workspace: value("workspace") ?? globals.workspace,
    });
    const fs = new NodeFs(systemRoot);
    await opened(fs);
    await captureNativeNodeEdits(fs);
    const result = workspaceReadPaths(
      sub === "create"
        ? await createRoleContext(fs, {
            roleId: value("id"),
            title: value("title")!,
            body: await text("body"),
          })
        : await deleteRole(fs, positionals[0]!),
      workspaceRoot,
    ) as { roleId: string; path: string };
    const json = values.json === true || globals.json === true;
    return {
      exitCode: 0,
      stdout:
        (json
          ? JSON.stringify({ ...result, workspaceRoot })
          : sub === "create"
            ? `Created ${result.roleId}  ${value("title")}\nFile: ${result.path}`
            : `Deleted ${result.roleId}`) + "\n",
      stderr: "",
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: cliErrorText(error, `tent role ${sub}`, errorContext) + "\n",
    };
  }
}

export function roleHelpText() {
  return `tent role — standing briefs for kinds of sessions; a Role receives Cards

  tent role create --title <text> [--body <text>|-] [--id <role-id>]
  tent role delete <role-id>

After create, read and edit .tent/roles/<role-id>.md with your own tools.
Retire a Role by setting status: deprecated in its file, or delete it; either way, first take or return its Cards, or cancel them with tent card deprecate.
--workspace <path> picks the Workspace; --json prints JSON.
`;
}
