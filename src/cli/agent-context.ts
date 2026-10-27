import type { FsAdapter } from "../core/store/adapter.js";
import { assembleAgentContext, type AgentContextStart } from "../core/read/agent-context.js";
import { projectAgentContext, formatAgentContextPage } from "../core/read/agent-context-page.js";
import { readModuleMapRepository } from "../fs/workspace-scan.js";
import { readNode } from "../core/read/node-query.js";
import { readWorkspaceSettings } from "../core/workspace/workspace-settings.js";

/** Wiring and byte measurement only; evidence and bounded projection belong to Core. */
export async function agentContextOutput<T extends object>(
  fs: FsAdapter,
  workspaceRoot: string,
  start: AgentContextStart,
  value: T,
  json: boolean,
  format: (value: T) => string,
) {
  const primary = value as {
    text?: string;
    nodeId?: string;
    cardId?: string;
    etag?: string;
    diagnostic?: unknown;
  };
  const read = async () => {
    if (start.kind === "node" && primary.text !== undefined && primary.etag) {
      const { workspaceId } = await readWorkspaceSettings(fs);
      if (!workspaceId)
        throw new Error(
          "Tent workspace identity is missing; explicitly initialize or convert this workspace",
        );
      await readNode(fs, workspaceId, {
        nodeId: start.nodeId,
        ...(start.version ? { version: start.version } : {}),
        view: "body",
        range: { unit: "utf16", start: 0, end: 0 },
        expectedEtag: primary.etag,
      });
    }
    return assembleAgentContext(fs, workspaceRoot, start, {
      repository: () => readModuleMapRepository(workspaceRoot),
    });
  };
  const context = await (fs.observationScope ? fs.observationScope(read) : read());
  // The outer transaction renderer exposes these fields too; include them in the same budget.
  const output = {
    ...value,
    ...(fs.recoveryConflicts?.length ? { recoveryConflicts: fs.recoveryConflicts } : {}),
  };
  const agentContext = projectAgentContext(
    context,
    workspaceRoot,
    {
      text: primary.text ?? "",
      bytes:
        start.kind === "brief"
          ? 0
          : Math.max(
              Buffer.byteLength(JSON.stringify(output)),
              Buffer.byteLength(format(output).trimEnd()),
            ),
      ...(primary.text !== undefined
        ? { nodeId: primary.nodeId, ...(!primary.diagnostic ? { cardId: primary.cardId } : {}) }
        : {}),
    },
    (page) =>
      Math.max(
        Buffer.byteLength(JSON.stringify({ ...output, agentContext: page }) + "\n"),
        Buffer.byteLength(format(output).trimEnd() + "\n\n" + formatAgentContextPage(page) + "\n"),
      ),
  );
  return {
    exitCode: 0,
    stdout: json
      ? JSON.stringify({ ...output, agentContext }) + "\n"
      : format(output).trimEnd() + "\n\n" + formatAgentContextPage(agentContext) + "\n",
    stderr: "",
  };
}
