import { transactionResult } from "./transaction-result.js";
import { workspaceReadPaths } from "./read-paths.js";
import { formatCliTime } from "./time-text.js";
import { captureNativeNodeEdits } from "../core/graph/node-native-capture.js";
import path from "node:path";
import { parseArgs } from "node:util";
import { NodeFs } from "../fs/node-fs.js";
import { resolveWorkspacePaths } from "./workspace-path.js";
import { missingExplicitSources, workspaceMaterialFields } from "./material-input.js";
import { stat } from "node:fs/promises";
import {
  isDirectoryMaterial,
  localMaterialPath,
  materialLocator,
  type MaterialSource,
} from "../core/base/material.js";
import { markdownMaterialHeading } from "../core/base/material-section.js";
import { parseFrontmatter } from "../core/base/frontmatter.js";
import {
  cardSourceSectionWarnings,
  createCardDocument,
  takeCardDocument,
  returnCardDocument,
  listCardDocuments,
  watchCardDocuments,
  deprecateCardDocument,
  type CardDocumentState,
} from "../core/graph/card-document.js";
import { pageBounds, pageItems } from "./reader-page.js";
import { cliErrorText, unknownCommandError, type ErrorContext } from "./error-text.js";

const CARD_COMMANDS = ["create", "list", "take", "return", "watch", "deprecate"];

export type CardCommandOptions = {
  workspace?: string;
  cwd?: string;
  json?: boolean;
  stdin?: string;
};
export type CardCommandResult = { exitCode: number; stdout: string; stderr: string };

export async function runCardCommand(
  sub: string,
  args: string[],
  globals: CardCommandOptions = {},
): Promise<CardCommandResult> {
  return transactionResult((opened) => runCardCommandOpened(sub, args, globals, opened));
}

async function runCardCommandOpened(
  sub: string,
  args: string[],
  globals: CardCommandOptions,
  opened: (fs: NodeFs) => Promise<void>,
): Promise<CardCommandResult> {
  const errorContext: ErrorContext = { workspace: globals.workspace };
  if (!sub || ["help", "--help", "-h"].includes(sub) || args.includes("--help"))
    return { exitCode: 0, stdout: cardHelpText(), stderr: "" };
  try {
    if (!CARD_COMMANDS.includes(sub)) throw unknownCommandError("tent card", sub, CARD_COMMANDS);
    const fields = [
      "workspace",
      ...(sub === "create"
        ? ["prompt", "title", "target", "return-to", "id"]
        : sub === "return"
          ? ["role", "result"]
          : sub === "list"
            ? ["role", "state", "start", "limit"]
            : sub === "watch"
              ? ["role", "timeout"]
              : sub === "take"
                ? ["role"]
                : []),
    ];
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        ...Object.fromEntries(fields.map((key) => [key, { type: "string" as const }])),
        json: { type: "boolean" },
        ...(sub === "create" ? { source: { type: "string", multiple: true } as const } : {}),
        ...(sub === "list" ? { "include-deprecated": { type: "boolean" } as const } : {}),
      },
    });
    const value = (key: string) => (values as Record<string, unknown>)[key] as string | undefined;
    const number = (key: string) => (value(key) === undefined ? undefined : Number(value(key)));
    errorContext.workspace = value("workspace") ?? globals.workspace;
    const selected = !["create", "list", "watch"].includes(sub);
    if (positionals.length === 1 && selected)
      errorContext.target = { kind: "card", id: positionals[0]! };
    if (positionals.length !== (selected ? 1 : 0))
      throw new Error(
        selected ? `Usage: tent card ${sub} <card-id>` : `tent card ${sub} takes no Card id`,
      );
    if (sub === "create" && !value("target"))
      throw new Error("Card create requires --target <role-id>, the Role that will take it");
    if (["take", "return", "watch"].includes(sub) && !value("role"))
      throw new Error(`tent card ${sub} requires --role <role-id>`);
    if (
      sub === "watch" &&
      value("timeout") !== undefined &&
      !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value("timeout")!)
    )
      throw new Error("--timeout must be a nonnegative number of seconds");
    if (
      value("state") !== undefined &&
      !["pending", "consumed", "returned", "closed"].includes(value("state")!)
    )
      throw new Error("--state must be pending, consumed, returned or closed");
    if (sub === "return" && value("result") === undefined)
      throw new Error("tent card return requires --result <one line>");
    const { systemRoot, workspaceRoot } = await resolveWorkspacePaths({
      cwd: globals.cwd,
      workspace: value("workspace") ?? globals.workspace,
    });
    const mutation = ["create", "deprecate", "take", "return"].includes(sub);
    const fs = new NodeFs(systemRoot),
      id = positionals[0]!;
    await opened(fs);
    const json = values.json === true || globals.json === true;
    if (sub === "watch") {
      const items = (await watchCardDocuments(fs, value("role")!, number("timeout"))).map(
        (item) => ({ ...item, take: `tent card take ${item.cardId} --role ${value("role")!}` }),
      );
      return {
        exitCode: items.length ? 0 : 2,
        stdout: !items.length
          ? ""
          : (json
              ? JSON.stringify(items)
              : items
                  .map((item) =>
                    item.state === "returned"
                      ? `${item.cardId} returned by ${item.receivedBy}: ${item.result}`
                      : [item.cardId, item.title?.replace(/\s+/g, " "), item.take]
                          .filter(Boolean)
                          .join("  "),
                  )
                  .join("\n")) + "\n",
        stderr: "",
      };
    }
    await captureNativeNodeEdits(fs);
    let result: unknown;
    let warnings: string[] = [];
    if (sub === "create") {
      let prompt = value("prompt") ?? "";
      if (prompt === "-") {
        if (globals.stdin !== undefined) prompt = globals.stdin;
        else {
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
          prompt = Buffer.concat(chunks).toString("utf8");
        }
      }
      const sources = (
        ((values as Record<string, unknown>).source as string[] | undefined) ?? []
      ).map((source) => ({ resource: source }));
      const material = await workspaceMaterialFields({ sources }, "cards/input.md", workspaceRoot);
      warnings = await missingExplicitSources(
        sources,
        material.sources as MaterialSource[],
        "cards/input.md",
        workspaceRoot,
      );
      const created = await createCardDocument(fs, {
        cardId: value("id"),
        prompt,
        title: value("title"),
        target: value("target")!,
        returnTo: value("return-to"),
        ...material,
      });
      warnings.push(
        ...(await cardSourceSectionWarnings(
          fs,
          created.path,
          created.sources,
          sources.map((source) => source.resource),
        )),
      );
      result = {
        cardId: created.cardId,
        state: created.state,
        target: created.target,
        ...(created.returnTo ? { returnTo: created.returnTo } : {}),
      };
    } else if (sub === "take") {
      const taken = await takeCardDocument(fs, id, value("role")!);
      result = {
        cardId: taken.cardId,
        path: path.join(systemRoot, taken.path),
        ...(taken.title ? { title: taken.title } : {}),
        state: taken.state,
        target: taken.target,
        ...(taken.returnTo ? { returnTo: taken.returnTo } : {}),
        receivedBy: taken.receivedBy,
        ...(taken.result ? { result: taken.result } : {}),
        replayed: taken.replayed,
        status: taken.status,
        ...(taken.notice ? { notice: taken.notice } : {}),
        // Closing a returned Card only delivers its result; the task went out already.
        ...(taken.state === "closed"
          ? {}
          : {
              text: taken.text,
              sources: await sourcePointers(fs, systemRoot, taken.path, taken.sources),
            }),
      };
    } else if (sub === "return")
      result = await returnCardDocument(fs, id, {
        roleId: value("role")!,
        result: value("result")!,
      });
    else if (sub === "deprecate") result = await deprecateCardDocument(fs, id);
    else {
      const { start, limit } = pageBounds(number("start"), number("limit"));
      const { items } = await listCardDocuments(fs, {
        roleId: value("role"),
        waiting: value("role") !== undefined && value("state") === undefined,
        state: value("state") as CardDocumentState | undefined,
        includeDeprecated: values["include-deprecated"] === true,
      });
      result = pageItems(items.slice(start, start + limit), start, items.length);
    }
    if (sub !== "take") result = workspaceReadPaths(result, workspaceRoot);
    return {
      exitCode: 0,
      stdout:
        (json
          ? JSON.stringify(mutation ? { ...(result as object), workspaceRoot } : result)
          : formatCard(result, sub)) + "\n",
      stderr: warnings.length ? `${warnings.join("\n")}\n` : "",
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: cliErrorText(error, `tent card ${sub}`, errorContext) + "\n",
    };
  }
}

export function cardHelpText() {
  return `tent card — hand work to a Role and collect the result

  tent card create --prompt <text>|- --target <role-id> [--title <text>] [--source <node-id|path>]... [--return-to <role-id>] [--id <card-id>]
  tent card list [--role <role-id>] [--state pending|consumed|returned|closed] [--include-deprecated]
                 [--limit <n>] [--start <n>]
  tent card take <card-id> --role <role-id>
  tent card return <card-id> --role <role-id> --result <one line>
  tent card watch --role <role-id> [--timeout <seconds>]
  tent card deprecate <card-id>

Write the task in the Card; sources point at the Nodes and files it needs. A sent Card never changes.
Sources keep their order. Name a Node by its id, a section as node-id#Heading. Paths start at the Workspace root: docs/req.md, ./docs/req.md and /docs/req.md are the same file; end a directory with /. An explicit ./, / or .tent/ source that names nothing prints a warning; the Card keeps it. Bare descriptive sources are kept without that warning.
list --role shows what waits for that Role: Cards to take, oldest first, then returns it owes, then results returned to it. With --state it lists that state instead; without --role, all Cards, newest first.
take prints the task, then each source's name and path; read the sources with your own tools. With --return-to, the receiver returns one line of at most 200 characters, and the return-to Role takes the Card again to read the result and close it. Repeating the same take or return is a replay, not a second run.
watch waits for Cards addressed to the Role, oldest first, then Cards returned to it. It checks every 3 seconds; --timeout 0 checks once. Exit codes: 0 = Cards (one line each, or a JSON array); 2 = timeout (no output); 1 = error.
deprecate cancels a Card. To change a task or its Role, cancel the Card and send a new one.
--workspace <path> picks the Workspace; --json prints JSON. In Git Bash, run commands whose arguments start with / with MSYS_NO_PATHCONV=1.
`;
}

/** Where each source lives, for the receiver's own tools; nothing is read on its behalf. */
async function sourcePointers(
  fs: NodeFs,
  tentRoot: string,
  owner: string,
  sources: ReadonlyArray<{ resource: string; file?: string; gone?: string }>,
) {
  const workspaceRoot = path.dirname(tentRoot);
  return Promise.all(
    sources.map(async (source) => {
      if (source.gone) return { name: source.gone, missing: true as const };
      let locator;
      let filename: string | undefined;
      try {
        locator = materialLocator(source.resource, owner, true);
        filename = source.file
          ? path.join(tentRoot, source.file)
          : localMaterialPath(locator, workspaceRoot);
      } catch {
        return { name: source.resource };
      }
      if (locator.kind === "unresolved") return { name: locator.text };
      if (filename === undefined) return { name: source.resource };
      const heading = markdownMaterialHeading(locator);
      const directory = isDirectoryMaterial(locator);
      const pointer = filename + (directory ? path.sep : "");
      const found = await stat(filename).then(
        (info) => (directory ? info.isDirectory() : info.isFile()),
        () => false,
      );
      const where = heading === undefined ? pointer : `${pointer}#${heading}`;
      const inTent = path.relative(tentRoot, filename).split(path.sep);
      let name = path.relative(workspaceRoot, filename).split(path.sep).join("/");
      if (inTent[0] === "roles" && inTent.length === 2) {
        const roleId = path.basename(filename, ".md");
        try {
          const title = parseFrontmatter(await fs.readFile(`roles/${roleId}.md`)).data.title;
          name = typeof title === "string" && title.trim() ? title : roleId;
        } catch {
          name = roleId;
        }
      } else if (inTent[0] === "cards" && inTent.length === 2)
        name = path.basename(filename, ".md");
      else if (inTent[0] !== ".." && inTent.length >= 2 && inTent.at(-1) === `${inTent.at(-2)}.md`)
        name = inTent.at(-2)!;
      return { name, path: where, ...(found ? {} : { missing: true as const }) };
    }),
  );
}

function formatCard(value: unknown, sub: string) {
  const card = value as {
    cardId: string;
    title?: string;
    target?: string;
    state?: string;
    status?: string;
    returnTo?: string;
    result?: string;
    replayed?: boolean;
    notice?: string;
    text?: string;
    sources?: Array<{ name: string; path?: string; missing?: true }>;
  };
  if (sub === "create")
    return [
      `cardId: ${card.cardId}`,
      `target: ${card.target}`,
      `state: ${card.state}`,
      card.returnTo ? `returnTo: ${card.returnTo}` : undefined,
    ]
      .filter(Boolean)
      .join("\n");
  if (sub === "take") {
    const header = [
      [card.cardId, card.title].filter(Boolean).join("  "),
      `State: ${card.state}`,
      card.state !== "closed" && card.returnTo ? `Return to: ${card.returnTo}` : undefined,
      card.state === "closed" ? `Result: ${card.result}` : undefined,
      `Replayed: ${card.replayed}`,
      card.notice,
    ]
      .filter(Boolean)
      .join("\n");
    if (card.text === undefined) return header;
    const sources = card.sources?.length
      ? [
          "Sources:",
          ...card.sources.map((source) =>
            source.path
              ? `- ${source.name}: ${source.path}${source.missing ? " (not found)" : ""}`
              : `- ${source.name}${source.missing ? " (not found)" : ""}`,
          ),
        ].join("\n")
      : undefined;
    return [header, card.text.trim(), sources].filter(Boolean).join("\n\n");
  }
  if (sub === "list") {
    const result = value as {
      items: Array<{
        cardId: string;
        state?: string;
        status?: string;
        returnTo?: string;
        result?: string;
        title?: string;
        publishedAt?: string;
        diagnostic?: string;
      }>;
      page: { hasMore: boolean; next?: number };
    };
    return (
      result.items
        .map((item) =>
          [
            item.cardId,
            item.state,
            item.returnTo ? `returnTo: ${item.returnTo}` : undefined,
            item.result,
            item.status === "deprecated" ? item.status : undefined,
            item.title,
            item.publishedAt ? formatCliTime(item.publishedAt) : undefined,
            item.diagnostic,
          ]
            .filter(Boolean)
            .join("  "),
        )
        .join("\n") + (result.page.hasMore ? `\nNext: --start ${result.page.next}` : "")
    );
  }
  return [
    [card.cardId, card.title].filter(Boolean).join("  "),
    `State: ${card.state}`,
    card.status === "deprecated" ? `Status: ${card.status}` : undefined,
    card.returnTo ? `Return to: ${card.returnTo}` : undefined,
    card.result ? `Result: ${card.result}` : undefined,
    card.replayed !== undefined ? `Replayed: ${card.replayed}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}
