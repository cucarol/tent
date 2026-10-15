import { open } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as z from "zod/v4";
import { createTurnPathResolver } from "../core/git-checkout.js";
import { isHistoryDocument } from "../core/document-history.js";
import type {
  SessionObservationActivity,
  SessionFileObservation,
  SessionSignal,
} from "../core/session-observations.js";

const entrySchema = z.object({
  type: z.string(),
  promptId: z.string().optional(),
  isSidechain: z.boolean().optional(),
  cwd: z.string().optional(),
  timestamp: z.string().optional(),
  message: z
    .object({
      content: z.union([
        z.string(),
        z.array(
          z.object({
            type: z.string().optional(),
            text: z.string().optional(),
            id: z.string().optional(),
            name: z.string().optional(),
            input: z.record(z.string(), z.unknown()).optional(),
            tool_use_id: z.string().optional(),
            is_error: z.boolean().optional(),
          }),
        ),
      ]),
    })
    .optional(),
  toolUseResult: z
    .object({
      type: z.string().optional(),
      filePath: z.string().optional(),
      structuredPatch: z.array(z.unknown()).optional(),
      file: z.object({ filePath: z.string().optional() }).optional(),
    })
    .nullable()
    .optional(),
});

/** Native Claude prompt_id/promptId, successful paired tool results, no shell inference. */
export async function readClaudeTurnActivity(
  transcriptPath: unknown,
  workspaceRoot: string,
  requestedPromptId: unknown,
  sessionCwd = workspaceRoot,
): Promise<SessionObservationActivity> {
  const activity: SessionObservationActivity = { observations: [], signals: [], uncertain: false };
  if (
    typeof transcriptPath !== "string" ||
    typeof requestedPromptId !== "string" ||
    !requestedPromptId
  )
    return { ...activity, uncertain: true };
  const resolver = await createTurnPathResolver(workspaceRoot, sessionCwd);
  const calls = new Map<string, { name: string; input: Record<string, unknown>; cwd: string }>();
  const signals = new Set<SessionSignal>();
  let active = false,
    found = false;
  const add = async (
    kind: SessionFileObservation["kind"],
    file: unknown,
    cwd: string,
    eventAt: unknown,
  ) => {
    if (typeof file !== "string" || !file || /[\u0000-\u001f]/.test(file)) {
      activity.uncertain = true;
      return;
    }
    const filename = path.resolve(cwd, file);
    const relative = await resolver.relative(filename);
    const inside =
      relative && relative !== ".." && !relative.startsWith("../") && !path.isAbsolute(relative);
    if (
      inside &&
      relative.startsWith(".tent/") &&
      kind === "written" &&
      isHistoryDocument(relative.slice(6)) &&
      !relative.startsWith(".tent/roles/")
    )
      activity.nodeOrCardChanged = true;
    if (
      inside &&
      relative
        .split("/")
        .some((part) => [".git", ".tent", ".scratch", "node_modules", ".venv"].includes(part))
    )
      return;
    activity.observations.push({
      kind,
      address: inside ? relative : pathToFileURL(filename).href,
      ...(typeof eventAt === "string" ? { eventAt } : {}),
    });
  };
  try {
    const handle = await open(transcriptPath, "r");
    let lines: string[];
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return { ...activity, uncertain: true };
      const start = Math.max(0, stat.size - 1024 * 1024);
      const bytes = Buffer.alloc(stat.size - start);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
      if (bytesRead !== bytes.length) return { ...activity, uncertain: true };
      lines = bytes.toString("utf8").split(/\r?\n/);
      if (start) {
        lines.shift();
        activity.uncertain = true;
      }
    } finally {
      await handle.close();
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = entrySchema.safeParse(JSON.parse(line));
      } catch {
        activity.uncertain = true;
        continue;
      }
      if (!parsed.success) {
        activity.uncertain = true;
        continue;
      }
      const row = parsed.data;
      if (row.isSidechain === true) continue;
      if (row.type !== "user" && row.type !== "assistant") continue;
      const content = row.message?.content;
      const results = Array.isArray(content)
        ? content.filter((part) => part?.type === "tool_result")
        : [];
      if (row.type === "user" && !results.length && typeof row.promptId === "string") {
        if (row.promptId === requestedPromptId) {
          active = true;
          found = true;
        } else if (active) break;
      }
      if (!active) continue;
      const cwd = typeof row.cwd === "string" ? row.cwd : (resolver.checkoutRoot ?? workspaceRoot);
      if (row.type === "user" && !results.length) {
        let text =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content
                  .filter((part) => part?.type === "text" && typeof part.text === "string")
                  .map((part) => part.text)
                  .join("\n")
              : "";
        if (!/^\s*<heartbeat(?:\s|>)/i.test(text)) {
          text = text.replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "");
          if (/^\s*# AGENTS\.md instructions for /i.test(text))
            text = text
              .replace(/^\s*# AGENTS\.md instructions for [^\r\n]*(?:\r?\n|$)/i, "")
              .replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/gi, "");
          if (/(?:新增需求|改成|\bnew requirement\b)/i.test(text))
            signals.add("possible-requirement");
          if (
            /(?:决定|确认|采用|就用|定为|同意|\b(?:decided|confirmed|agreed|adopt(?:ed)?)\b)/i.test(
              text,
            )
          )
            signals.add("possible-decision");
        }
      }
      if (row.type === "assistant" && Array.isArray(content))
        for (const part of content) {
          if (
            part?.type === "tool_use" &&
            typeof part.id === "string" &&
            typeof part.name === "string" &&
            part.input &&
            typeof part.input === "object"
          )
            calls.set(part.id, { name: part.name, input: part.input, cwd });
        }
      for (const result of results) {
        if (row.promptId !== requestedPromptId) {
          activity.uncertain = true;
          continue;
        }
        const call = result.tool_use_id ? calls.get(result.tool_use_id) : undefined;
        if (!call) {
          activity.uncertain = true;
          continue;
        }
        calls.delete(result.tool_use_id!);
        if (result.is_error === true) continue;
        if (call.name === "Write") {
          if (
            (row.toolUseResult?.type === "create" || row.toolUseResult?.type === "update") &&
            row.toolUseResult.filePath === call.input.file_path
          )
            await add("written", call.input.file_path, call.cwd, row.timestamp);
          else activity.uncertain = true;
        } else if (call.name === "Edit") {
          if (
            row.toolUseResult?.filePath === call.input.file_path &&
            Array.isArray(row.toolUseResult?.structuredPatch)
          )
            await add("written", call.input.file_path, call.cwd, row.timestamp);
          else activity.uncertain = true;
        } else if (call.name === "Read") {
          if (row.toolUseResult?.file?.filePath === call.input.file_path)
            await add("read", call.input.file_path, call.cwd, row.timestamp);
          else activity.uncertain = true;
        } else activity.uncertain = true;
      }
    }
  } catch {
    activity.uncertain = true;
  }
  activity.uncertain ||= !found || calls.size > 0;
  activity.signals = [...signals];
  return activity;
}
