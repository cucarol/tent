import { validationIssueText } from "../core/validation-message.js";

export type ErrorContext = {
  target?: { kind: "node" | "card" | "role"; id: string };
  heading?: string;
  baseEtag?: string;
  json?: boolean;
  workspace?: string;
  workspaceRoot?: string;
  outputResource?: string;
  details?: unknown;
};

/** Keep the diagnostic, then give one safe, copyable inspection/help command. */
export function cliErrorText(error: unknown, command: string, context: ErrorContext = {}): string {
  const issues = validationIssueText(error);
  let message =
    issues !== undefined
      ? `${command}: ${issues}`
      : error instanceof Error
        ? error.message
        : String(error);
  const target = context.target;
  let showDetails = Boolean(context.details);
  const errorCode = (error as { code?: string } | undefined)?.code;
  if (!context.json && command.startsWith("tent node ")) {
    if (errorCode === "ETAG_CONFLICT") {
      const details = context.details as { nodeId?: string; baseEtag?: string } | undefined;
      const nodeId = details?.nodeId ?? (target?.kind === "node" ? target.id : undefined);
      const given = details?.baseEtag ?? context.baseEtag;
      message =
        nodeId && given
          ? `Node ${nodeId} changed after your read: etag ${given} is stale.`
          : "The Node changed after your read; its etag is stale.";
      showDetails = false;
    } else if (errorCode === "INCOMPLETE_READ") {
      message =
        command === "tent node confirm"
          ? "Confirmation requires a complete live Node read."
          : "A read: ETag comes from a partial read and allows metadata edits only.";
      showDetails = false;
    }
  }
  if (
    command === "tent node link-output" &&
    message.startsWith("Output file not found:") &&
    context.workspaceRoot &&
    context.outputResource
  )
    message = `Output file not found: ${context.outputResource} (local paths resolve from the Workspace root ${context.workspaceRoot}).`;
  const missingNode = /^(?:Parent )?Node not found: (node-[a-z0-9]+)\.?$/i.exec(message)?.[1];
  const missingRole = /^Role not found: (role-[a-z0-9]+)\.?$/i.exec(message)?.[1];
  const fileError = error as NodeJS.ErrnoException | undefined;
  const missingPath = fileError?.path?.replaceAll("\\", "/");
  const missingCard =
    target?.kind === "card" &&
    fileError?.code === "ENOENT" &&
    (missingPath?.endsWith(`/cards/${target.id}.md`) || missingPath?.endsWith("/cards"));
  const existing =
    /Node id already exists: (node-[a-z0-9]+)/i.exec(message)?.[1] ??
    (/^A sibling Node already uses the name /.test(message)
      ? /: (node-[a-z0-9]+)\.$/i.exec(message)?.[1]
      : undefined);
  let next = [...command.split(" ").slice(0, 3), "--help"];
  if (/^Unknown (?:card command|role subcommand):/.test(message))
    next = [...command.split(" ").slice(0, 2), "--help"];
  else if (existing) next = ["tent", "node", "get", existing, "--full"];
  else if (missingRole || /^Role unavailable:|^target Role.*missing/i.test(message)) {
    if (missingRole) message = `Role not found: ${missingRole}.`;
    next = ["tent", "role", "list"];
  } else if (missingNode || /^Node is not readable in this source:/.test(message)) {
    if (missingNode) message = `Node not found: ${missingNode}.`;
    next = ["tent", "node", "list", "--full"];
  } else if (missingCard) {
    message = `Card not found: ${target!.id}.`;
    next = ["tent", "card", "list"];
  } else if (
    /etag|changed|reread|read:|complete.*read|another Role|addressed to|lock.*busy|waiting.*seconds/i.test(
      message,
    )
  ) {
    if (command.endsWith(" create")) next = ["tent", "workspace", "brief"];
    else if (target?.kind === "node")
      next =
        command.includes("write-section") && context.heading
          ? ["tent", "node", "get-section", target.id, "--heading", context.heading]
          : ["tent", "node", "get", target.id, "--full"];
    else if (target?.kind === "card") next = ["tent", "card", "show", target.id];
    else if (target?.kind === "role") next = ["tent", "role", "show", target.id];
    else next = ["tent", "workspace", "brief"];
  }
  if (context.workspace) next.push("--workspace", context.workspace);
  const comment =
    /^tent node (?:create|type|write-many)(?: |$)/.test(command) &&
    message === "Node type must be goal, prompt or output."
      ? "  # words like decision or evidence go in --tags"
      : "";
  return [
    message,
    ...(showDetails ? [JSON.stringify(context.details)] : []),
    `Next: ${next.map(shellWord).join(" ")}${comment}`,
  ].join("\n");
}

function shellWord(value: string): string {
  if (/^[a-z0-9_./:\\-]+$/i.test(value) && (process.platform === "win32" || !value.includes("\\")))
    return value;
  return process.platform === "win32"
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", `'"'"'`)}'`;
}
