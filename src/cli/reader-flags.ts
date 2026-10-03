export function readerFlags(flags: Record<string, string>) {
  return {
    ...(flags["version-json"] !== undefined ? { version: JSON.parse(flags["version-json"]) } : {}),
    ...(flags.view !== undefined ? { view: flags.view } : {}),
    ...(flags.range !== undefined ? { range: JSON.parse(flags.range) } : {}),
    ...(flags["expected-etag"] !== undefined ? { expectedEtag: flags["expected-etag"] } : {}),
    ...(flags.cursor !== undefined ? { cursor: flags.cursor } : {}),
    ...(flags.limit !== undefined ? { limit: Number(flags.limit) } : {}),
    ...(flags.resource !== undefined ? { resource: flags.resource } : {}),
    ...(flags["include-archived"] !== undefined
      ? { includeArchived: flags["include-archived"] === "true" }
      : {}),
    ...(flags.parent !== undefined
      ? { parentNodeId: flags.parent === "root" ? null : flags.parent }
      : {}),
    ...(flags.direction !== undefined ? { direction: flags.direction } : {}),
  };
}
