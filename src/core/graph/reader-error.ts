export class ReaderError extends Error {
  constructor(
    readonly code: "INVALID_INPUT" | "SOURCE_CHANGED",
    message: string,
  ) {
    super(message);
  }
}
