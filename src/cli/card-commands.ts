import { parseArgs } from "node:util";
import { NodeFs } from "../fs/node-fs.js";
import { resolveWorkspacePaths } from "./workspace-path.js";
import {
  createCardDocument,
  readCardDocument,
  takeCardDocument,
  listCardDocuments,
  watchCardDocuments,
  moveCardDocument,
  deprecateCardDocument,
  type CardDocumentState,
} from "../core/card-document.js";
import { pageItems, pageText, formatTextPage } from "./reader-page.js";

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
  if (!sub || ["help", "--help", "-h"].includes(sub) || args.includes("--help"))
    return { exitCode: 0, stdout: cardHelpText(sub), stderr: "" };
  try {
    if (!["create", "move", "deprecate", "list", "get", "show", "take", "watch"].includes(sub))
      throw new Error(`Unknown card command: ${sub}`);
    const fields = [
      "workspace",
      ...(sub === "create"
        ? ["prompt", "title", "target", "id"]
        : sub === "move"
          ? ["to", "base-etag"]
          : sub === "deprecate"
            ? ["base-etag"]
            : sub === "list"
              ? ["role", "state", "start", "limit", "expected-revision"]
              : sub === "watch"
                ? ["role", "timeout"]
                : ["show", "get"].includes(sub)
                  ? ["view", "start", "end", "expected-etag"]
                  : ["role"]),
    ];
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        ...Object.fromEntries(fields.map((key) => [key, { type: "string" as const }])),
        json: { type: "boolean" },
        ...(sub === "create" ? { source: { type: "string", multiple: true } as const } : {}),
        ...(sub === "list"
          ? {
              "include-open": { type: "boolean" } as const,
              "include-deprecated": { type: "boolean" } as const,
            }
          : {}),
        ...(sub === "move" ? { public: { type: "boolean" } as const } : {}),
      },
    });
    const value = (key: string) => (values as Record<string, unknown>)[key] as string | undefined;
    const number = (key: string) => (value(key) === undefined ? undefined : Number(value(key)));
    if (positionals.length !== (["create", "list", "watch"].includes(sub) ? 0 : 1))
      throw new Error("Expected one Card id except for create/list/watch");
    if (sub === "watch" && !value("role")) throw new Error("Watch requires --role role-ID");
    if (
      sub === "watch" &&
      value("timeout") !== undefined &&
      !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value("timeout")!)
    )
      throw new Error("--timeout must be a nonnegative number of seconds");
    if (value("view") !== undefined && !["body", "raw"].includes(value("view")!))
      throw new Error("--view must be body or raw");
    if (
      ["get", "show"].includes(sub) &&
      (value("start") === undefined) !== (value("end") === undefined)
    )
      throw new Error("Supply both --start and --end");
    if (["get", "show"].includes(sub) && number("start")! > 0 && !value("expected-etag"))
      throw new Error("--start after zero requires --expected-etag from the previous page");
    if (value("state") !== undefined && !["pending", "consumed"].includes(value("state")!))
      throw new Error("Invalid --state");
    if (sub === "deprecate" && !value("base-etag"))
      throw new Error(`${sub} requires --base-etag from a raw read`);
    if (
      sub === "move" &&
      (!value("base-etag") || (value("to") !== undefined) === (values.public === true))
    )
      throw new Error("Move requires --base-etag and exactly one of --to role-ID or --public");
    const { systemRoot, workspaceRoot } = await resolveWorkspacePaths({
      cwd: globals.cwd,
      workspace: value("workspace") ?? globals.workspace,
    });
    const fs = new NodeFs(systemRoot, "cli"),
      id = positionals[0]!;
    let result: unknown;
    if (sub === "watch") {
      const items = (await watchCardDocuments(fs, value("role")!, number("timeout"))).map(
        (item) => ({
          ...item,
          take: `tent card take ${item.cardId} --role ${value("role")!}`,
        }),
      );
      return {
        exitCode: items.length ? 0 : 2,
        stdout: !items.length
          ? ""
          : (values.json === true || globals.json === true
              ? JSON.stringify(items)
              : items
                  .map((item) =>
                    [item.cardId, item.title?.replace(/\s+/g, " "), item.take]
                      .filter(Boolean)
                      .join("  "),
                  )
                  .join("\n")) + "\n",
        stderr: "",
      };
    }
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
      ).map((source) =>
        source.trimStart().startsWith("{") ? JSON.parse(source) : { resource: source },
      );
      result = await createCardDocument(fs, {
        cardId: value("id"),
        prompt,
        title: value("title"),
        target: value("target"),
        sources,
      });
    } else if (sub === "deprecate")
      result = await deprecateCardDocument(fs, id, value("base-etag")!);
    else if (sub === "move")
      result = await moveCardDocument(fs, id, {
        target: values.public === true ? null : value("to")!,
        expectedEtag: value("base-etag")!,
      });
    else if (sub === "list")
      result = pageItems(
        await listCardDocuments(fs, {
          roleId: value("role"),
          state: value("state") as CardDocumentState | undefined,
          includeOpen: values["include-open"] === true,
          includeDeprecated: values["include-deprecated"] === true,
        }),
        "card.list",
        {
          start: number("start"),
          limit: number("limit"),
          expectedRevision: value("expected-revision"),
        },
      );
    else if (sub === "get" || sub === "show") {
      const options = {
        view: value("view") as "body" | "raw" | undefined,
        expectedEtag: value("expected-etag"),
      };
      const observed = await readCardDocument(fs, id, options);
      pageText(observed, `card.${sub}:${id}`, {
        start: number("start"),
        end: number("end"),
        maxBytes: 16 * 1024 - 256,
      });
      result = pageText(
        await readCardDocument(fs, id, { ...options, expectedEtag: observed.etag, capture: true }),
        `card.${sub}:${id}`,
        { start: number("start"), end: number("end") },
      );
    } else
      result = pageText(
        { ...(await takeCardDocument(fs, id, value("role"))), workspaceRoot },
        `card.get:${id}`,
      );
    const json = values.json === true || globals.json === true;
    const mutation = ["create", "move", "deprecate", "take"].includes(sub);
    return {
      exitCode: 0,
      stdout:
        (json
          ? JSON.stringify(mutation ? { ...(result as object), workspaceRoot } : result)
          : formatCard(result, sub) + (mutation ? `\nWorkspace: ${workspaceRoot}` : "")) + "\n",
      stderr: "",
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: (error instanceof Error ? error.message : String(error)) + "\n",
    };
  }
}

export function cardHelpText(_sub?: string) {
  return `tent card — recorded prompt input with optional Role context
  tent card create --prompt TEXT|- [--title TEXT] [--source PATH|JSON ...] [--target role-ID] [--id card-ID]
  tent card list [--role role-ID --include-open] [--state pending|consumed] [--include-deprecated]
                 [--start N --expected-revision HASH] [--limit N]
  tent card show card-ID [--view body|raw] [--start N --end N --expected-etag HASH]
  tent card move card-ID (--to role-ID | --public) --base-etag HASH
  tent card deprecate card-ID --base-etag HASH
  tent card take card-ID [--role role-ID]
  tent card watch --role role-ID [--timeout SECONDS]
All commands accept --workspace PATH and --json. CLI output is paged; Core returns complete data.
Sources keep their order. Selected Node/Role sources retain commit/path; external sources are addresses only.
Show is a preview; take records reception and returns an input page. A replay is not a new execution.
Use page.next for long input. Put requirements in Nodes; a Card briefly points to them. Update Nodes when requirements change.
Targeted Cards require their Role; untargeted Cards can be received without one.
Watch reads committed pending Cards for exactly that Role, writes no files, and exits when input exists.
It checks HEAD every 3 seconds; omit --timeout to wait indefinitely, or use 0 for one immediate check.
Watch exit codes: 0 = Cards (one line per Card, or a JSON array); 2 = timeout (no output); 1 = error.
Progress counts active output Nodes whose sources explicitly name this Card. goalCount counts pinned goals containing those outputs; generated/verified timestamps provide completion times. Progress reads current documents without replaying history.
Only published pending Cards can move. Requirements awaiting a decision belong in Nodes marked status: draft.
Cancelled published tasks can be deprecated without changing their input or reception. Deprecated Cards are excluded from lists by default.
`;
}

function formatCard(value: unknown, sub: string) {
  if (["show", "get", "take"].includes(sub)) {
    const result = value as {
      state?: string;
      progress?: string | null;
      goalCount?: number;
      totalGoalCount?: number;
      diagnostic?: string;
      notice?: string;
      currentReferences?: Array<{ kind: string; id: string; path: string }>;
      currentReferencesDiagnostic?: string;
    };
    return [
      [
        result.state,
        result.progress,
        (result.totalGoalCount ?? 0) > 1
          ? `${result.goalCount}/${result.totalGoalCount}`
          : undefined,
      ]
        .filter(Boolean)
        .join("  "),
      result.notice,
      result.diagnostic,
      result.currentReferences?.map((ref) => `${ref.kind} ${ref.id}  ${ref.path}`).join("\n"),
      result.currentReferencesDiagnostic,
      formatTextPage(value),
    ]
      .filter((part) => part !== undefined && part !== "")
      .join("\n\n");
  }
  if (sub === "list") {
    const result = value as {
      items: Array<{
        cardId: string;
        state?: string;
        status?: string;
        progress?: string | null;
        goalCount?: number;
        totalGoalCount?: number;
        title?: string;
        publishedAt?: string;
        diagnostic?: string;
      }>;
      page: { hasMore: boolean; next?: unknown };
    };
    return (
      result.items
        .map((item) =>
          [
            item.cardId,
            item.state,
            item.progress,
            (item.totalGoalCount ?? 0) > 1 ? `${item.goalCount}/${item.totalGoalCount}` : undefined,
            item.status === "deprecated" ? item.status : undefined,
            item.title,
            item.publishedAt,
            item.diagnostic,
          ]
            .filter(Boolean)
            .join("  "),
        )
        .join("\n") + (result.page.hasMore ? `\nNext: ${JSON.stringify(result.page.next)}` : "")
    );
  }
  return JSON.stringify(value, null, 2);
}
