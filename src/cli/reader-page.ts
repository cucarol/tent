const budget = 16 * 1024 - 1; // The CLI appends one terminating newline.

/** Where a page starts and how many records it may hold, from --start and --limit. */
export function pageBounds(start = 0, limit = 20) {
  if (!Number.isSafeInteger(start) || start < 0)
    throw new Error("--start must be a whole number, 0 or more");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error("--limit must be a whole number from 1 to 100");
  return { start, limit };
}

/**
 * One page of a list of `total` records, given the records from `start` on. A page stays
 * inside the output budget by holding fewer records, and always holds at least one.
 */
export function pageItems<T>(items: T[], start: number, total: number) {
  const make = (count: number) => {
    const end = start + count;
    return {
      items: items.slice(0, count),
      page: { hasMore: end < total, ...(end < total ? { next: end } : {}) },
    };
  };
  let count = items.length;
  while (count > 1 && Buffer.byteLength(JSON.stringify(make(count))) > budget) count--;
  return make(count);
}
