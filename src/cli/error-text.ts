import { validationIssueText } from "../core/validation-message.js";

/** Schema failures name the command and field instead of printing raw issue JSON. */
export function cliErrorText(error: unknown, command: string): string {
  const issues = validationIssueText(error);
  if (issues !== undefined) return `${command}: ${issues}`;
  return error instanceof Error ? error.message : String(error);
}
