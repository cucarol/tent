import path from "node:path";
type Event = Record<string, unknown>;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export function answeredQuestion(event: Event): boolean {
  if (
    !/^(?:functions\.)?(?:request_user_input(?:_async)?|AskUserQuestion)$/.test(
      String(event.tool_name),
    )
  )
    return false;
  let response = event.tool_response;
  if (typeof response === "string") {
    try {
      response = JSON.parse(response);
    } catch {
      return false;
    }
  }
  const result = record(response);
  const answers = record(result?.answers);
  return (
    result?.isError !== true &&
    result?.is_error !== true &&
    result?.cancelled !== true &&
    !!answers &&
    Object.values(answers).some((answer) =>
      typeof answer === "string"
        ? answer.trim().length > 0
        : Array.isArray(record(answer)?.answers) &&
          (record(answer)!.answers as unknown[]).some(
            (value) => typeof value === "string" && value.trim().length,
          ),
    )
  );
}

/** Native successful results only: inputs by themselves never establish writes. */
export function successfulWritePaths(host: string, event: Event): string[] {
  const input = record(event.tool_input);
  let response = event.tool_response;
  if (host === "claude-code") {
    const result = record(response);
    if (!result || result.isError === true || result.is_error === true || result.cancelled === true)
      return [];
    const name = event.tool_name;
    const matches = (left: unknown, right: unknown) =>
      typeof left === "string" &&
      typeof right === "string" &&
      path.relative(
        path.resolve(String(event.cwd), left),
        path.resolve(String(event.cwd), right),
      ) === "";
    if (
      (name === "Write" && ["create", "update"].includes(String(result.type))) ||
      ((name === "Edit" || name === "MultiEdit") && Array.isArray(result.structuredPatch))
    )
      return typeof input?.file_path === "string" && matches(result.filePath, input.file_path)
        ? [input.file_path]
        : [];
    if (name === "NotebookEdit")
      return typeof input?.notebook_path === "string" &&
        matches(result.filePath ?? result.notebook_path, input.notebook_path)
        ? [input.notebook_path]
        : [];
    return [];
  }
  if (event.tool_name !== "apply_patch" || typeof input?.command !== "string") return [];
  if (typeof response === "string") {
    try {
      response = JSON.parse(response);
    } catch {
      /* plain success output */
    }
  }
  const result = record(response);
  const output = result ? result.output : response;
  if (
    result &&
    (record(result.metadata)?.exit_code !== 0 ||
      result.isError === true ||
      result.is_error === true ||
      result.cancelled === true)
  )
    return [];
  if (typeof output !== "string" || !output.startsWith("Success. Updated the following files:\n"))
    return [];
  // The result lists paths the native patch actually published, including renames/deletions.
  const lines = output.trimEnd().split("\n").slice(1);
  if (!lines.length || lines.some((line) => !/^[AMD] .+$/.test(line))) return [];
  return lines.map((line) => line.slice(2));
}
