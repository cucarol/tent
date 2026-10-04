import { open } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as z from "zod/v4";
import { isHistoryDocument } from "../core/document-history.js";
import {
  sessionFileObservationSchema,
  type SessionFileObservation,
  type SessionObservationActivity,
  type SessionSignal,
} from "../core/session-observations.js";

const ARTIFACT_EXCLUDED = [".git", ".tent", ".worktrees", ".scratch", "node_modules", ".venv"];
const entrySchema = z.object({
  type: z.string(),
  timestamp: z.string().optional(),
  payload: z.object({
    type: z.string().optional(),
    turn_id: z.string().optional(),
    name: z.string().optional(),
    input: z.string().optional(),
    arguments: z.string().optional(),
    call_id: z.string().optional(),
    output: z.unknown().optional(),
    item: z.unknown().optional(),
    role: z.string().optional(),
    content: z.unknown().optional(),
    message: z.string().optional(),
    local_images: z.array(z.string()).optional(),
  }),
});
const itemSchema = z.object({
  type: z.string(),
  status: z.string().optional(),
  tool: z.string().optional(),
  name: z.string().optional(),
  namespace: z.string().optional(),
  path: z.string().optional(),
  text: z.string().optional(),
  local_images: z.array(z.string()).optional(),
  content: z.unknown().optional(),
  call_id: z.string().optional(),
  cwd: z.string().optional(),
  exit_code: z.number().nullable().optional(),
  changes: z
    .record(
      z.string(),
      z.object({ type: z.string().optional(), move_path: z.string().nullable().optional() }),
    )
    .optional(),
  parsed_cmd: z.array(z.object({ type: z.string(), path: z.string().optional() })).optional(),
});
export type CodexTurnActivity = SessionObservationActivity & {
  /** Workspace-relative changed paths, including deletion/move sources, for material advice. */
  paths: string[];
  hasFileChanges?: true;
};

/** Codex transcript events are evidence, not a complete file authorship log. */
export async function readCodexTurnActivity(
  transcriptPath: unknown,
  workspaceRoot: string | undefined,
  requestedTurnId: unknown,
): Promise<CodexTurnActivity> {
  const unknownActivity: CodexTurnActivity = {
    paths: [],
    observations: [],
    signals: [],
    uncertain: true,
  };
  if (
    typeof transcriptPath !== "string" ||
    !transcriptPath ||
    typeof requestedTurnId !== "string" ||
    !requestedTurnId
  )
    return unknownActivity;
  let turnId: string | undefined,
    uncertain = false,
    cancelled = false,
    hasFileChanges = false,
    nodeOrCardChanged = false;
  const paths = new Set<string>();
  const observations: SessionFileObservation[] = [];
  const signals = new Set<SessionSignal>();
  const seen = new Set<string>();
  const calls = new Map<string, { name: string; input: string; observed: boolean }>();
  const addPath = (
    kind: SessionFileObservation["kind"] | undefined,
    file: string,
    eventAt?: string,
    sourceRoot = workspaceRoot,
    actualWrite = kind === "written",
  ) => {
    try {
      if (!file || /[\u0000-\u001f]/.test(file)) {
        uncertain = true;
        return;
      }
      const uri = file.startsWith("file:") ? new URL(file) : undefined;
      if (uri && (uri.search || uri.hash)) {
        uncertain = true;
        return;
      }
      if (!uri && !path.isAbsolute(file) && !sourceRoot) {
        uncertain = true;
        return;
      }
      if (!uri && /^[a-z][a-z\d+.-]*:/i.test(file) && !path.isAbsolute(file)) return;
      const filename = uri ? fileURLToPath(uri) : path.resolve(sourceRoot ?? "", file);
      const relative = workspaceRoot
        ? path.relative(workspaceRoot, filename).replace(/\\/g, "/")
        : undefined;
      const inside =
        relative !== undefined &&
        relative !== ".." &&
        !relative.startsWith("../") &&
        !path.isAbsolute(relative);
      if (
        inside &&
        relative!.startsWith(".tent/") &&
        actualWrite &&
        !relative!
          .slice(".tent/".length)
          .split("/")
          .some((part) => ARTIFACT_EXCLUDED.includes(part))
      ) {
        const document = relative!.slice(".tent/".length);
        if (isHistoryDocument(document) && !document.startsWith("roles/")) nodeOrCardChanged = true;
      }
      if (inside && relative!.split("/").some((part) => ARTIFACT_EXCLUDED.includes(part))) return;
      if (inside && !relative) return;
      const address = inside ? relative! : pathToFileURL(filename).href;
      const observation = sessionFileObservationSchema.parse({
        kind: kind ?? "written",
        address,
        ...(eventAt ? { eventAt } : {}),
      });
      const key = JSON.stringify([kind, address, eventAt]);
      if (kind !== undefined && !seen.has(key)) {
        seen.add(key);
        observations.push(observation);
      }
      if (kind === "written" || kind === undefined) {
        hasFileChanges = true;
        if (inside) paths.add(relative!);
      }
    } catch {
      uncertain = true;
    }
  };
  // Only advisory signals use prose, transiently. Never guess file addresses from prose,
  // tool output, shell commands, or a model's reasoning.
  const userText = (text: string | undefined) => {
    if (!text) return;
    if (/^\s*<heartbeat(?:\s|>)/i.test(text)) return;
    text = text.replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "");
    if (/^\s*# AGENTS\.md instructions for /i.test(text))
      text = text
        .replace(/^\s*# AGENTS\.md instructions for [^\r\n]*(?:\r?\n|$)/i, "")
        .replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/gi, "");
    if (/(?:新增需求|改成|\bnew requirement\b)/i.test(text)) signals.add("possible-requirement");
    if (
      /(?:决定|确认|采用|就用|定为|同意|\b(?:decided|confirmed|agreed|adopt(?:ed)?)\b)/i.test(text)
    )
      signals.add("possible-decision");
  };
  const userContent = (content: unknown, eventAt?: string) => {
    if (!Array.isArray(content)) return;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      if (p.type === "input_text" && typeof p.text === "string") userText(p.text);
      if (p.type === "input_file") {
        if (typeof p.file_path === "string") addPath("provided", p.file_path, eventAt);
        else if (typeof p.file_url === "string" && p.file_url.startsWith("file:"))
          addPath("provided", p.file_url, eventAt);
      }
      if (
        p.type === "input_image" &&
        typeof p.image_url === "string" &&
        p.image_url.startsWith("file:")
      )
        addPath("provided", p.image_url, eventAt);
    }
  };
  try {
    const handle = await open(transcriptPath, "r");
    let lines: string[];
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return unknownActivity;
      const start = Math.max(0, stat.size - 1024 * 1024),
        bytes = Buffer.alloc(stat.size - start);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
      if (bytesRead !== bytes.length) return unknownActivity;
      lines = bytes.toString("utf8").split(/\r?\n/);
      if (start) lines.shift();
    } finally {
      await handle.close();
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = entrySchema.safeParse(JSON.parse(line));
      } catch {
        uncertain = true;
        continue;
      }
      if (!parsed.success) {
        uncertain = true;
        continue;
      }
      const { type, payload, timestamp } = parsed.data;
      const eventAt =
        timestamp && z.iso.datetime({ offset: true }).safeParse(timestamp).success
          ? timestamp
          : undefined;
      if (
        ((type === "event_msg" && payload.type === "task_started") || type === "turn_context") &&
        payload.turn_id
      ) {
        if (turnId === requestedTurnId && payload.turn_id !== turnId) break;
        if (turnId !== payload.turn_id) {
          turnId = payload.turn_id;
          uncertain = false;
          cancelled = false;
          hasFileChanges = false;
          nodeOrCardChanged = false;
          paths.clear();
          calls.clear();
          observations.length = 0;
          signals.clear();
          seen.clear();
        }
      }
      if (requestedTurnId !== turnId) continue;
      if (payload.turn_id && payload.turn_id !== turnId) continue;
      if (type === "event_msg" && payload.type === "turn_aborted") cancelled = true;
      if (type === "event_msg" && payload.type === "user_message") {
        userText(payload.message);
        for (const file of payload.local_images ?? []) addPath("provided", file, eventAt);
      }
      if (type === "response_item" && payload.type === "message" && payload.role === "user")
        userContent(payload.content, eventAt);
      if (type === "event_msg" && payload.type === "item_completed") {
        const result = itemSchema.safeParse(payload.item);
        if (!result.success) {
          uncertain = true;
          continue;
        }
        const item = result.data;
        if (
          item.type === "FunctionCallOutput" &&
          item.namespace === "codex_app" &&
          item.name === "send_message_to_thread"
        )
          continue;
        if (
          ["FileChange", "CommandExecution", "McpToolCall", "WebSearch", "ImageView"].includes(
            item.type,
          )
        ) {
          if (item.call_id) {
            if (calls.has(item.call_id)) calls.get(item.call_id)!.observed = true;
            else uncertain = true;
          } else if (calls.size === 1) for (const call of calls.values()) call.observed = true;
          else if (calls.size > 1) uncertain = true;
        }
        if (item.type === "FileChange") {
          if (item.status !== "completed" || !item.changes) uncertain = true;
          else
            for (const [file, change] of Object.entries(item.changes)) {
              addPath(
                undefined,
                file,
                eventAt,
                workspaceRoot,
                ["add", "update", "delete"].includes(change.type ?? ""),
              );
              if (change.type === "add") addPath("written", file, eventAt);
              else if (change.type === "update")
                addPath("written", change.move_path ?? file, eventAt);
              else if (change.type !== "delete") uncertain = true;
            }
        } else if (item.type === "CommandExecution") {
          if (
            !item.parsed_cmd?.length ||
            item.parsed_cmd.some(
              (command) => !["read", "list_files", "search"].includes(command.type),
            )
          )
            uncertain = true;
          if (
            item.parsed_cmd?.some(
              (command) =>
                command.type === "read" &&
                (!command.path ||
                  item.status !== "completed" ||
                  (item.exit_code !== undefined && item.exit_code !== 0)),
            )
          )
            uncertain = true;
          if (item.status === "completed" && (item.exit_code === undefined || item.exit_code === 0))
            for (const command of item.parsed_cmd ?? [])
              if (command.type === "read" && command.path) {
                if (item.cwd && !path.isAbsolute(item.cwd)) uncertain = true;
                else addPath("read", command.path, eventAt, item.cwd ?? workspaceRoot);
              }
        } else if (item.type === "ImageView") {
          if ((item.status !== undefined && item.status !== "completed") || !item.path)
            uncertain = true;
          else addPath("read", item.path, eventAt);
        } else if (item.type === "UserMessage") {
          userText(item.text);
          userContent(item.content, eventAt);
          for (const file of item.local_images ?? []) addPath("provided", file, eventAt);
        } else if (item.type === "McpToolCall") {
          if (!nonArtifactTool(item.tool ?? "")) uncertain = true;
        } else if (!["AgentMessage", "Reasoning", "HookPrompt", "WebSearch"].includes(item.type))
          uncertain = true;
      }
      if (type !== "response_item") continue;
      if (payload.type?.endsWith("_call") && payload.call_id) {
        calls.set(payload.call_id, {
          name: payload.name ?? "",
          input: payload.arguments ?? payload.input ?? "",
          observed: false,
        });
      } else if (payload.type?.endsWith("_call_output") && payload.call_id) {
        const call = calls.get(payload.call_id);
        if (!call) {
          uncertain = true;
          continue;
        }
        if (
          !call.observed &&
          /^(?:functions\.)?apply_patch$/.test(call.name) &&
          patchSucceeded(payload.output)
        ) {
          const changes = patchFiles(call.input);
          if (!changes) uncertain = true;
          else
            for (const change of changes) {
              addPath(undefined, change.path, eventAt, workspaceRoot, true);
              if (change.written) addPath("written", change.written, eventAt);
            }
          call.observed = true;
        }
        if (
          !call.observed &&
          /^(?:functions\.)?view_image$/.test(call.name) &&
          imageSucceeded(payload.output)
        ) {
          try {
            const args = z.object({ path: z.string() }).parse(JSON.parse(call.input));
            addPath("read", args.path, eventAt);
            call.observed = true;
          } catch {
            uncertain = true;
          }
        }
        if (!call.observed && !nonArtifactTool(call.name)) {
          if (!/^(?:functions\.)?exec$/.test(call.name) || /\btools\b/.test(call.input))
            uncertain = true;
        }
        calls.delete(payload.call_id);
      }
    }
  } catch {
    return unknownActivity;
  }
  if (requestedTurnId !== turnId) return unknownActivity;
  return {
    paths: [...paths],
    observations,
    signals: [...signals],
    uncertain: uncertain || calls.size > 0,
    ...(cancelled ? { cancelled: true as const } : {}),
    ...(hasFileChanges ? { hasFileChanges: true as const } : {}),
    ...(nodeOrCardChanged ? { nodeOrCardChanged: true as const } : {}),
  };
}

function patchSucceeded(output: unknown): boolean {
  if (typeof output !== "string") return false;
  try {
    const parsed = JSON.parse(output) as { output?: unknown; metadata?: { exit_code?: number } };
    return (
      parsed.metadata?.exit_code === 0 &&
      typeof parsed.output === "string" &&
      parsed.output.startsWith("Success. Updated the following files:\n")
    );
  } catch {
    return output.startsWith("Success. Updated the following files:\n");
  }
}
function patchFiles(input: string): Array<{ path: string; written?: string }> | undefined {
  if (!input.startsWith("*** Begin Patch\n") || !input.trimEnd().endsWith("*** End Patch"))
    return undefined;
  const files: Array<{ path: string; written?: string }> = [];
  let current: { path: string; written?: string } | undefined;
  let operation: string | undefined;
  for (const line of input.split("\n")) {
    const match = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
    if (!match) continue;
    if (match[1] === "Move to") {
      if (operation !== "Update File" || !current) return undefined;
      current.written = match[2]!;
    } else {
      operation = match[1];
      current = { path: match[2]!, ...(operation === "Delete File" ? {} : { written: match[2]! }) };
      files.push(current);
    }
  }
  return files.length ? files : undefined;
}
function imageSucceeded(output: unknown): boolean {
  try {
    const value: unknown = typeof output === "string" ? JSON.parse(output) : output;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const result = value as Record<string, unknown>;
    return (
      result.isError !== true &&
      typeof result.image_url === "string" &&
      result.image_url.startsWith("data:image/")
    );
  } catch {
    return false;
  }
}
function nonArtifactTool(name: string): boolean {
  return (
    /^(?:functions\.)?(?:list_mcp_resources|list_mcp_resource_templates|read_mcp_resource)$/.test(
      name,
    ) || /^(?:web[._]|mcp__codex_app__get_usage_limits$|clock[._])/.test(name)
  );
}
