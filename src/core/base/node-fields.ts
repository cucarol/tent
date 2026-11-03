const retiredNodeFields = [
  "sync",
  "planned",
  "outputs",
  "sha256",
  "resource_sha256",
  "supersedes",
  "verified",
] as const;

export function assertNodeFields(data: Record<string, unknown>): void {
  for (const field of retiredNodeFields)
    if (data[field] !== undefined)
      throw new Error(`Node field ${field} is retired; remove it from the document`);
  if (Array.isArray(data.sources))
    for (const source of data.sources)
      for (const field of ["sha256", "resource_sha256"])
        if (source && typeof source === "object" && source[field] !== undefined)
          throw new Error(`Source field ${field} is retired; remove it from the document`);
}
