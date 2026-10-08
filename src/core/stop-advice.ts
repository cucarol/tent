import type { FsAdapter } from "./adapter.js";
import { inspectWorkspaceSync } from "./node-sync.js";
import { readSessionObservations, type SessionObservationEvent } from "./session-observations.js";
import {
  findUnlinkedOutputs,
  materialAddressKey,
  observationAddressKey,
  type WorkspaceSync,
} from "./context-brief.js";
import { nodeNotePath } from "./paths.js";
import { nodeTypeOf } from "./node-type.js";

export type StopQuestion = {
  kind: "unlinked-output" | "behind-node" | "possible-intent";
  question: string;
  answers: string[];
};
const fits = (message: string) =>
  Buffer.byteLength(JSON.stringify({ systemMessage: message }) + "\n", "utf8") <= 2048;
const literal = (text: string) => JSON.stringify(text);
const nodeUncertain = (node: WorkspaceSync["nodes"][number]) =>
  "uncertain" in node && node.uncertain === true;

/** Use the saved observation, never a copied transcript or material body. */
export function questionsForObservedTurn(
  sync: WorkspaceSync,
  workspaceRoot: string,
  event: SessionObservationEvent,
  earlierEvents: SessionObservationEvent[],
): StopQuestion[] {
  if (event.cancelled) return [];
  const previousVersions = new Map<string, string | undefined>();
  for (const previous of [...earlierEvents].sort((a, b) =>
    b.observedAt.localeCompare(a.observedAt),
  )) {
    if (previous.sessionId === event.sessionId && previous.turnId === event.turnId) continue;
    for (const file of previous.files) {
      const key = observationAddressKey(workspaceRoot, file.address);
      if (key && !previousVersions.has(key))
        previousVersions.set(
          key,
          file.version.state === "observed" ? file.version.sha256 : undefined,
        );
    }
  }
  const newlyObserved = event.files.filter((file) => {
    const key = observationAddressKey(workspaceRoot, file.address);
    return (
      key &&
      (!previousVersions.has(key) ||
        file.version.state !== "observed" ||
        previousVersions.get(key) !== file.version.sha256)
    );
  });
  const readKeys = new Set(
    event.files
      .filter((file) => file.kind === "read" || file.kind === "provided")
      .map((file) => observationAddressKey(workspaceRoot, file.address))
      .filter((key): key is string => !!key),
  );
  const requirements = sync.nodes.filter(
    (node) => nodeTypeOf(node.type) === "goal" && !nodeUncertain(node),
  );
  const sameMaterial = requirements
    .filter((node) =>
      node.materials.some((material) => {
        const key = materialAddressKey(workspaceRoot, nodeNotePath(node.path), material.resource);
        return key && readKeys.has(key);
      }),
    )
    .slice(0, 2);
  const candidates = sameMaterial.length ? sameMaterial : requirements.slice(0, 2);
  const unlinked = findUnlinkedOutputs(sync, [event], workspaceRoot);
  const questions: StopQuestion[] = [];
  const newOutput = newlyObserved.find(
    (file) =>
      file.kind === "written" &&
      unlinked.some(
        (output) =>
          output.address &&
          observationAddressKey(workspaceRoot, file.address) ===
            observationAddressKey(workspaceRoot, output.address),
      ),
  );
  if (newOutput)
    questions.push({
      kind: "unlinked-output",
      question: `This turn produced ${literal(newOutput.address)} without an output Node. Which goal should record it?`,
      answers: [
        ...candidates.map((node) => `Create an output Node under ${node.nodeId}`),
        ...(candidates.length ? [] : ["Find or create a confirmed goal first"]),
        "Leave unlinked for now",
      ],
    });
  const currentKeys = new Set(
    newlyObserved
      .map((file) => observationAddressKey(workspaceRoot, file.address))
      .filter((key): key is string => !!key),
  );
  const behind = sync.nodes.find((node) => {
    if (node.state !== "behind") return false;
    const matches = (resource: string) => {
      const key = materialAddressKey(workspaceRoot, nodeNotePath(node.path), resource);
      return !!key && currentKeys.has(key);
    };
    return (
      matches(`/${nodeNotePath(node.path)}`) ||
      node.materials.some(
        (material) =>
          material.state !== "current" &&
          material.state !== "unanchored" &&
          matches(material.resource),
      )
    );
  });
  if (behind)
    questions.push({
      kind: "behind-node",
      question: `A file version observed this turn puts ${behind.nodeId} behind. Does the Node's judgment still hold?`,
      answers: [
        "Still holds: read it fully, then node confirm",
        "Changed: update the Node and confirm",
        "Keep the goal; review the affected output before confirming",
      ],
    });
  if (event.signals.length && !event.nodeOrCardChanged)
    questions.push({
      kind: "possible-intent",
      question: `Turn ${literal(event.turnId)} may contain ${event.signals.includes("possible-decision") ? "a new decision or requirement" : "a new requirement"}. Which judgment should be saved?`,
      answers: [
        ...(candidates[0] ? [`Update existing ${candidates[0].nodeId}`] : []),
        "Create a confirmed goal or prompt",
        "Discussion only; do not save",
      ],
    });
  return questions.slice(0, 3);
}

export function formatStopQuestions(
  questions: StopQuestion[],
  uncertain = false,
): string | undefined {
  const lines = [
    "Tent turn review (addresses and options are advisory; nothing is saved automatically):",
  ];
  let count = 0;
  for (const question of questions.slice(0, 3)) {
    const candidate = `${count + 1}. ${question.question}\nOptions: ${question.answers.join("; ")}.`;
    if (
      !fits(
        [
          ...lines,
          candidate,
          ...(uncertain
            ? ["Some observations are incomplete; use workspace brief to check the current state."]
            : []),
        ].join("\n"),
      )
    )
      continue;
    lines.push(candidate);
    count++;
  }
  if (uncertain)
    lines.push("Some observations are incomplete; use workspace brief to check the current state.");
  if (!count && !uncertain) return undefined;
  return lines.join("\n");
}

/** Keep Node inspection uncertainty visible even when no turn observation raised it. */
export function formatObservedTurnAdvice(
  sync: WorkspaceSync,
  workspaceRoot: string,
  event: SessionObservationEvent,
  previous: { events: SessionObservationEvent[]; uncertain: boolean },
): string | undefined {
  if (event.cancelled) return undefined;
  return formatStopQuestions(
    questionsForObservedTurn(sync, workspaceRoot, event, previous.events),
    event.uncertain || previous.uncertain || sync.nodes.some(nodeUncertain),
  );
}

/** Advisory only: at most three questions, no document save or model continuation. */
export async function stopAdvice(
  fs: FsAdapter,
  workspaceRoot: string,
  event: SessionObservationEvent,
): Promise<string | undefined> {
  if (event.cancelled) return undefined;
  const [sync, previous] = await Promise.all([
    inspectWorkspaceSync(fs),
    readSessionObservations(fs, { sessionId: event.sessionId }),
  ]);
  return formatObservedTurnAdvice(sync, workspaceRoot, event, previous);
}
