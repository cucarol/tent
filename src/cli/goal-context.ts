import type { FsAdapter } from "../core/adapter.js";
import { readGoalContext, type GoalContextItem } from "../core/goal-context.js";
import { inspectNodesSync } from "../core/node-sync.js";

const budget = 1024;
const labels = {
  self: "Self",
  ancestor: "Ancestor",
  child: "Child",
  goal: "Goal",
  incoming: "Incoming",
  outgoing: "Outgoing",
  prompt: "Rule",
  output: "Output",
  card: "Card",
};
const clip = (value: string, length: number) => {
  const chars = [...value.replace(/\s+/g, " ").trim()];
  return chars.length > length ? chars.slice(0, length - 1).join("") + "…" : chars.join("");
};
const bytes = (value: string) => Buffer.byteLength(JSON.stringify({ context: value }), "utf8");

/** Keep the read payload and its edit token independent of this bounded navigation hint. */
export async function goalContextText(fs: FsAdapter, nodeId: string): Promise<string> {
  const items = await readGoalContext(fs, nodeId);
  if (!items.length) return "Context: no related items";
  const selected: GoalContextItem[] = [];
  const render = (entries: GoalContextItem[], length = 12, descriptionLength = 8) => {
    const lines = entries.map((item) => {
      const description = clip(item.description, descriptionLength);
      return `${labels[item.kind]}${item.kind === "child" ? `(${clip(item.type ?? "", 12)})` : ""}${item.relationKinds ? `(${item.relationKinds.join("/")})` : ""} ${clip(item.name, length)} ${item.id}${description ? ` ${description}` : ""}${item.state ? ` [${item.state}${item.progress !== undefined ? `/${item.progress ?? "—"}` : ""}]` : ""}${item.receiver ? ` ${clip(item.receiver, 12)}` : ""}`;
    });
    const omitted = Object.keys(labels).flatMap((kind) => {
      const count =
        items.filter((item) => item.kind === kind).length -
        entries.filter((item) => item.kind === kind).length;
      return count ? [`${labels[kind as keyof typeof labels]}+${count}`] : [];
    });
    return `Context\n${lines.join("\n")}${omitted.length ? `\nOmitted ${omitted.join(" ")}; continue with node relations <id> --direction parent|children|incoming|outgoing` : ""}`;
  };
  const priority = [
    ...items.filter(
      (item) => item.kind === "self" || item.kind === "ancestor" || item.kind === "goal",
    ),
    ...[...new Set(items.filter((item) => item.kind === "child").map((item) => item.type))].flatMap(
      (type) => items.find((item) => item.kind === "child" && item.type === type) ?? [],
    ),
    ...["incoming", "outgoing", "card", "output", "prompt"].flatMap(
      (kind) => items.find((item) => item.kind === kind) ?? [],
    ),
    ...items,
  ];
  for (const item of priority) {
    if (selected.includes(item)) continue;
    const reserved = [...selected, item].map((entry) =>
      entry.sync ? { ...entry, state: `${entry.state}/unanchored` } : entry,
    );
    if (bytes(render(reserved)) > budget) continue;
    selected.push(item);
  }
  const outputIds = [...new Set(selected.filter((item) => item.sync).map((item) => item.id))];
  const sync = new Map(
    (outputIds.length ? await inspectNodesSync(fs, outputIds) : []).map((inspection) => [
      inspection.nodeId,
      inspection.state,
    ]),
  );
  for (const item of selected)
    if (item.sync && sync.has(item.id)) item.state = `${item.state}/${sync.get(item.id)}`;
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
