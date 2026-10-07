/**
 * Display text for schema validation failures: `field.path: message`, joined by "; ".
 * Returns undefined for any other error so callers keep their existing message.
 */
export function validationIssueText(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.name !== "ZodError") return undefined;
  const issues = (error as { issues?: unknown }).issues;
  if (!Array.isArray(issues) || issues.length === 0) return undefined;
  return issues
    .map((issue: { path?: readonly PropertyKey[]; message?: string }) => {
      const field = issuePath(issue.path ?? []);
      const message = issue.message ?? "Invalid value";
      return field ? `${field}: ${message}` : message;
    })
    .join("; ");
}

function issuePath(path: readonly PropertyKey[]): string {
  return path.reduce<string>(
    (text, key) =>
      typeof key === "number" ? `${text}[${key}]` : text ? `${text}.${String(key)}` : String(key),
    "",
  );
}
