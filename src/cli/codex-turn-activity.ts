import { open } from "node:fs/promises";
import * as path from "node:path";
import * as z from "zod/v4";
const ARTIFACT_EXCLUDED = [".git", ".tent", ".worktrees", ".scratch", "node_modules", ".venv"];

const entrySchema = z.object({
  type: z.string(),
  payload: z.object({
    type: z.string().optional(),
    turn_id: z.string().optional(),
    name: z.string().optional(),
    input: z.string().optional(),
    call_id: z.string().optional(),
    output: z.unknown().optional(),
    item: z.unknown().optional(),
  }),
});
const itemSchema = z.object({
  type: z.string(),
  status: z.string().optional(),
  tool: z.string().optional(),
  name: z.string().optional(),
  namespace: z.string().optional(),
  changes: z
    .record(z.string(), z.object({ move_path: z.string().nullable().optional() }))
    .optional(),
  parsed_cmd: z.array(z.object({ type: z.string() })).optional(),
});

export type CodexTurnActivity = {
  paths: string[];
  uncertain: boolean;
  cancelled?: true;
  hasFileChanges?: true;
};

/** Codex transcript events are evidence, not a complete file authorship log. */
export async function readCodexTurnActivity(
  transcriptPath: unknown,
  workspaceRoot: string | undefined,
  requestedTurnId: unknown,
): Promise<CodexTurnActivity> {
  const unknownActivity = { paths: [], uncertain: true };
  if (
    typeof transcriptPath !== "string" ||
    !transcriptPath ||
    typeof requestedTurnId !== "string" ||
    !requestedTurnId
  )
    return unknownActivity;
  let turnId: string | undefined;
  let uncertain = false;
  let cancelled = false;
  let hasFileChanges = false;
  const paths = new Set<string>();
  const calls = new Map<string, { name: string; input: string; observed: boolean }>();
  const addPath = (file: string) => {
    if (!workspaceRoot) return;
    const relative = path
      .relative(workspaceRoot, path.resolve(workspaceRoot, file))
      .replace(/\\/g, "/");
    if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative))
      return;
    if (relative.split("/").some((part) => ARTIFACT_EXCLUDED.includes(part))) return;
    paths.add(relative);
  };
  try {
    const handle = await open(transcriptPath, "r");
    let lines: string[];
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return unknownActivity;
      // A long turn outside this bounded observation window stays uncertain.
      // Never build a transcript index or scan a whole conversation at every Stop.
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
      const { type, payload } = parsed.data;
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
          paths.clear();
          calls.clear();
        }
      }
      if (requestedTurnId !== turnId) continue;
      if (
        type === "event_msg" &&
        payload.type === "turn_aborted" &&
        (!payload.turn_id || payload.turn_id === turnId)
      )
        cancelled = true;
      if (type === "event_msg" && payload.type === "item_completed") {
        if (payload.turn_id && payload.turn_id !== turnId) continue;
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
          if (calls.size === 1) for (const call of calls.values()) call.observed = true;
          else if (calls.size > 1) uncertain = true;
        }
        if (item.type === "FileChange") {
          if (item.status !== "completed" || !item.changes) uncertain = true;
          else
            for (const [file, change] of Object.entries(item.changes)) {
              hasFileChanges = true;
              addPath(file);
              if (change.move_path) addPath(change.move_path);
            }
        } else if (item.type === "CommandExecution") {
          if (
            !item.parsed_cmd?.length ||
            item.parsed_cmd.some(
              (command) => !["read", "list_files", "search"].includes(command.type),
            )
          )
            uncertain = true;
        } else if (item.type === "McpToolCall") {
          if (!nonArtifactTool(item.tool ?? "")) uncertain = true;
        } else if (
          ![
            "AgentMessage",
            "UserMessage",
            "Reasoning",
            "HookPrompt",
            "WebSearch",
            "ImageView",
          ].includes(item.type)
        ) {
          uncertain = true;
        }
      }
      if (type !== "response_item") continue;
      if (payload.type?.endsWith("_call") && payload.call_id) {
        calls.set(payload.call_id, {
          name: payload.name ?? "",
          input: payload.input ?? "",
          observed: false,
        });
      } else if (payload.type?.endsWith("_call_output") && payload.call_id) {
        const call = calls.get(payload.call_id);
        if (!call) continue;
        if (!call.observed && !nonArtifactTool(call.name)) {
          // Pure tool discovery runs inside exec's isolated JS runtime without touching files.
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
  if (cancelled) return { paths: [], uncertain: false, cancelled: true };
  return {
    paths: [...paths],
    uncertain: uncertain || calls.size > 0,
    ...(hasFileChanges ? { hasFileChanges: true as const } : {}),
  };
}

function nonArtifactTool(name: string): boolean {
  return (
    /^(?:functions\.)?(?:view_image|list_mcp_resources|list_mcp_resource_templates|read_mcp_resource)$/.test(
      name,
    ) || /^(?:web[._]|mcp__codex_app__get_usage_limits$|clock[._])/.test(name)
  );
}
