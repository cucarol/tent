/** Keys compare by code unit, independently of host locale. */
export function cardOrderKey(id: string, publishedAt: string, order?: string): string {
  return order ?? `${new Date(publishedAt).toISOString()}|${id}`;
}

export function validCardOrder(id: string, value: unknown): value is string {
  return typeof value === "string" && /^[!-~]+$/.test(value) && value.endsWith(`~${id}`);
}

/** Printable ASCII fractional indexing; keys never end with the minimum digit (!). */
export function cardOrderBetween(id: string, lower?: string, upper?: string): string {
  if (lower !== undefined && upper !== undefined && lower >= upper)
    throw new Error("Card queue bounds are not strictly ordered");
  // Retain the tail's timestamp prefix, so later publication times still follow it.
  if (lower !== undefined && upper === undefined) return `${lower}~${id}`;
  let a = lower ?? "",
    b = upper,
    prefix = "";
  for (;;) {
    let common = 0;
    while (common < a.length && b !== undefined && a[common] === b[common]) common++;
    prefix += a.slice(0, common);
    a = a.slice(common);
    b = b?.slice(common);
    const low = a.charCodeAt(0) || 33,
      high = b?.charCodeAt(0) || 127;
    if (high - low > 1) {
      // The suffix prevents a generated key from colliding with a later default
      // timestamp/id key, and gives every Card its own generated identity.
      return `${prefix}${String.fromCharCode(Math.floor((low + high) / 2))}~${id}`;
    }
    prefix += String.fromCharCode(low);
    a = a.slice(1);
    b = high === low ? b?.slice(1) : undefined;
  }
}
