import type { FsAdapter } from "../core/adapter.js";
import { readGoalContext, type GoalContextItem } from "../core/goal-context.js";
import { inspectNodeSync } from "../core/node-sync.js";

const budget = 1024;
const labels = { ancestor: "上级", prompt: "规则", output: "产出", card: "Card" };
const clip = (value: string, length: number) => {
  const chars = [...value.replace(/\s+/g, " ").trim()];
  return chars.length > length ? chars.slice(0, length - 1).join("") + "…" : chars.join("");
};
const bytes = (value: string) => Buffer.byteLength(JSON.stringify({ context: value }), "utf8");

/** Keep the read payload and its edit token independent of this bounded navigation hint. */
export async function goalContextText(fs: FsAdapter, nodeId: string): Promise<string> {
  const items = await readGoalContext(fs, nodeId);
  if (!items.length) return "上下文：无关联项";
  const selected: GoalContextItem[] = [];
  const render = (entries: GoalContextItem[], length = 12, descriptionLength = 8) => {
    const lines = entries.map(
      (item) =>
        `${labels[item.kind]} ${clip(item.name, length)} ${item.id} ${clip(item.description, descriptionLength) || "—"}${item.state ? ` [${item.state}]` : ""}${item.receiver ? ` ${item.receiver}` : ""}`,
    );
    const omitted = Object.keys(labels).flatMap((kind) => {
      const count =
        items.filter((item) => item.kind === kind).length -
        entries.filter((item) => item.kind === kind).length;
      return count ? [`${labels[kind as keyof typeof labels]}+${count}`] : [];
    });
    return `上下文\n${lines.join("\n")}${omitted.length ? `\n省略 ${omitted.join(" ")}；用 relations/list/card list 继续查找` : ""}`;
  };
  // Reserve one result and one Card before filling scope rules; each category stays discoverable.
  const priority = [
    ...items.filter((item) => item.kind === "ancestor"),
    ...["output", "card"].flatMap((kind) => items.find((item) => item.kind === kind) ?? []),
    ...items.filter((item) => item.kind === "prompt"),
    ...items.filter((item) => item.kind === "output" || item.kind === "card"),
  ];
  for (const item of priority) {
    if (selected.includes(item)) continue;
    const candidate = { ...item };
    if (item.kind === "output") {
      // Leave enough space for the longest sync state before reading this selected result.
      candidate.state += "/unanchored";
    }
    if (bytes(render([...selected, candidate], 12)) > budget) continue;
    if (item.kind === "output")
      candidate.state = `${item.state}/${(await inspectNodeSync(fs, item.id)).state}`;
    Object.assign(item, candidate);
    selected.push(item);
  }
  selected.sort((a, b) => items.indexOf(a) - items.indexOf(b));
  for (const [nameLength, descriptionLength] of [
    [64, 48],
    [32, 24],
    [24, 16],
    [16, 8],
    [12, 8],
  ]) {
    const text = render(selected, nameLength, descriptionLength);
    if (bytes(text) <= budget) return text;
  }
  return render(selected);
}
