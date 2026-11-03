export class ReaderError extends Error {
  constructor(
    readonly code: "INVALID_INPUT" | "SOURCE_CHANGED" | "INVALID_RANGE",
    message: string,
  ) {
    super(message);
  }
}
