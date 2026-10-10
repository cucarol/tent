import { workspaceReadPaths } from "./read-paths.js";
import { captureNativeNodeEdits } from "../core/node-native-capture.js";
import { parseArgs } from "node:util";
import { NodeFs } from "../fs/node-fs.js";
import { resolveWorkspacePaths } from "./workspace-path.js";
import {
  createRoleContext,
  editRoleContext,
  listRoleContexts,
  readRolePage,
} from "../core/role-context.js";
import { pageItems, pageText, formatTextPage } from "./reader-page.js";
import { deleteRole } from "../core/role-delete.js";
import { cliErrorText, type ErrorContext } from "./error-text.js";

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
  const errorContext: ErrorContext = { workspace: globals.workspace };
  if (!sub || ["help", "--help", "-h"].includes(sub))
    return { exitCode: 0, stdout: roleHelpText(), stderr: "" };
  try {
    if (!["list", "show", "write", "create", "delete"].includes(sub))
      throw new Error(`Unknown role subcommand: ${sub}`);
    const flags = [
      "workspace",
      ...(sub === "list"
        ? ["start", "limit", "expected-revision"]
        : sub === "show"
          ? ["view", "start", "end", "expected-etag"]
          : sub === "delete"
            ? ["base-etag"]
            : sub === "create"
              ? ["title", "body", "id"]
              : ["body", "raw", "base-etag", "title", "status"]),
    ];
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
    const number = (key: string) => (value(key) === undefined ? undefined : Number(value(key)));
    errorContext.workspace = value("workspace") ?? globals.workspace;
    const selected = ["show", "write", "delete"].includes(sub);
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
      throw new Error("Expected an explicit Role id only for show/write/delete");
    if (sub === "create" && !value("title")?.trim())
      throw new Error("Role create requires --title");
    if (["write", "delete"].includes(sub) && !value("base-etag"))
      throw new Error(`Role ${sub} requires --base-etag from show`);
    if (sub === "show" && (value("start") === undefined) !== (value("end") === undefined))
      throw new Error("Supply both --start and --end");
    if (sub === "show" && number("start")! > 0 && !value("expected-etag"))
      throw new Error("--start after zero requires --expected-etag from the previous page");
    if (value("view") !== undefined && !["raw", "body"].includes(value("view")!))
      throw new Error("--view must be raw or body");
    const { systemRoot, workspaceRoot } = await resolveWorkspacePaths({
      cwd: globals.cwd,
      workspace: value("workspace") ?? globals.workspace,
    });
    const fs = new NodeFs(systemRoot, "cli");
    await captureNativeNodeEdits(fs);
    let result: unknown;
    if (sub === "list")
      result = pageItems(await listRoleContexts(fs), "role.list", {
        start: number("start"),
        limit: number("limit"),
        expectedRevision: value("expected-revision"),
      });
    else if (sub === "show") {
      const options = {
        view: value("view") as "body" | "raw" | undefined,
        expectedEtag: value("expected-etag"),
      };
      const observed = workspaceReadPaths(
        await readRolePage(fs, positionals[0]!, options),
        workspaceRoot,
      );
      pageText(observed, `role.show:${positionals[0]}`, {
        start: number("start"),
        end: number("end"),
        maxBytes: 16 * 1024 - 256,
      });
      result = pageText(
        workspaceReadPaths(
          await readRolePage(fs, positionals[0]!, {
            ...options,
            expectedEtag: observed.etag,
            capture: true,
          }),
          workspaceRoot,
        ),
        `role.show:${positionals[0]}`,
        { start: number("start"), end: number("end") },
      );
    } else if (sub === "create")
      result = await createRoleContext(fs, {
        roleId: value("id"),
        title: value("title")!,
        body: await text("body"),
      });
    else if (sub === "delete")
      result = await deleteRole(fs, positionals[0]!, { baseEtag: value("base-etag")! });
    else {
      const frontmatter = Object.fromEntries(
        ["title", "status"]
          .filter((key) => value(key) !== undefined)
          .map((key) => [key, value(key)]),
      );
      result = await editRoleContext(fs, positionals[0]!, {
        baseEtag: value("base-etag")!,
        raw: await text("raw"),
        body: await text("body"),
        ...(Object.keys(frontmatter).length ? { frontmatter } : {}),
      });
    }
    result = workspaceReadPaths(result, workspaceRoot);
    const json = values.json === true || globals.json === true;
    const mutation = ["create", "write", "delete"].includes(sub);
    return {
      exitCode: 0,
      stdout:
        (json
          ? JSON.stringify(mutation ? { ...(result as object), workspaceRoot } : result)
          : (sub === "create"
              ? `Created ${(result as { roleId: string }).roleId}  ${value("title")}`
              : formatRole(result, sub)) + (mutation ? `\nWorkspace: ${workspaceRoot}` : "")) +
        "\n",
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
  return `tent role — durable Role Markdown, directly through Core
  tent role list [--start N --expected-revision HASH] [--limit N]
  tent role create --title TEXT [--body TEXT|-] [--id role-ID]
  tent role show role-ID [--view body|raw] [--start N --end N --expected-etag HASH]
  tent role write role-ID --base-etag HASH [--raw TEXT|- | --body TEXT|-]
                  [--title TEXT] [--status draft|stable|deprecated]
  tent role delete role-ID --base-etag HASH
All commands accept --workspace PATH and --json. list reads headers; show captures the selected document in Tent Git.
Use the returned page.next range and ETag to continue a long read. Writes reject stale ETags.
Reading never imports a Node or creates a Role. Legacy documents require explicit conversion.
Delete removes the Role document; Tent Git keeps its history and its id is never reused. Move or deprecate pending Cards that target it first.
`;
}

function formatRole(value: unknown, sub: string) {
  const identity = value as { roleId: string; path?: string; etag?: string };
  if (sub === "delete") return `Deleted ${identity.roleId}`;
  if (sub === "show")
    return `${identity.roleId}  ${identity.path ?? ""}\nETag: ${identity.etag}\n${formatTextPage(value)}`;
  if (sub === "list") {
    const result = value as {
      items: Array<{ roleId: string; title?: string }>;
      page: { hasMore: boolean; next?: unknown };
    };
    return (
      result.items.map((item) => `${item.roleId}  ${item.title ?? ""}`).join("\n") +
      (result.page.hasMore ? `\nNext: ${JSON.stringify(result.page.next)}` : "")
    );
  }
  return `Updated ${identity.roleId}\nETag: ${identity.etag}`;
}
