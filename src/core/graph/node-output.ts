import { hasDocumentHistory } from "../store/history-port.js";
import { withTentMutation, type FsAdapter } from "../store/adapter.js";
import { contentEtag } from "../base/etag.js";
import {
  materialLocator,
  isDirectoryMaterial,
  validateMaterialAddresses,
} from "../base/material.js";
import nodePath from "node:path";
import { loadNodeCatalog } from "./node-catalog.js";
import { NodeWriteError } from "./node-document-write.js";
import { cardRecordPath, nodeNotePath } from "../base/paths.js";
import { canonicalDocumentReferences } from "./document-links.js";
import { isRequirementNode, goalAncestors } from "./node-relations.js";
import { createNodeUnlocked } from "./ops.js";
import { normalizeTagList } from "../base/tags.js";
import { validateNodeName } from "../store/scaffold.js";
import { listCardDocuments, readCardDocument } from "./card-document.js";
import { readCardGoalIds, type CardSourceInput } from "./card-context.js";

export function linkNodeOutput(
  fs: FsAdapter,
  goalId: string,
  input: {
    resource: string;
    /** The caller's spelling of resource, used only in messages. */
    label?: string;
    name?: string;
    cardId?: string;
    roleId?: string;
    tags?: string[];
  },
) {
  return withTentMutation(
    fs,
    async () => {
      // A plain output: tags come only from the caller.
      const tags = normalizeTagList(input.tags ?? []);
      const catalog = await loadNodeCatalog(fs),
        goal = catalog.byId.get(goalId);
      if (
        !goal ||
        !isRequirementNode({ type: goal.type }) ||
        goal.status === null ||
        goal.status === "deprecated"
      )
        throw new NodeWriteError("INVALID_INPUT", "Output creation requires a current goal Node");
      const descriptor = { resource: input.resource };
      const addressOwner = "index.md";
      await canonicalDocumentReferences(fs, addressOwner, descriptor, "");
      // index.md lives in .tent, so ../ is the pure namespace address of its Workspace.
      if (
        descriptor.resource === input.resource &&
        !/^(?:\/|[a-z][a-z\d+.-]*:)/i.test(input.resource.trim())
      )
        descriptor.resource = `../${input.resource.trim()}`;
      validateMaterialAddresses(descriptor, addressOwner);
      const locator = materialLocator(descriptor.resource, addressOwner, false);
      const localPath =
        locator.kind === "path"
          ? locator.target
          : locator.kind === "uri" && locator.uri.startsWith("file:")
            ? decodeURIComponent(new URL(locator.uri).pathname)
            : undefined;
      const warnings = localPath?.split("/").slice(0, -1).includes(".worktrees")
        ? ["材料位于 .worktrees/：先合并到主检出，再挂产出。"]
        : [];
      if (locator.kind === "path" || (locator.kind === "uri" && locator.uri.startsWith("file:"))) {
        if (!fs.observeMaterial)
          throw new NodeWriteError(
            "INVALID_INPUT",
            "Local output creation requires a material observer",
          );
        try {
          await fs.observeMaterial(descriptor.resource, addressOwner);
        } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
            throw new NodeWriteError(
              "INVALID_INPUT",
              `Output ${isDirectoryMaterial(locator) ? "directory" : "file"} not found: ${input.label ?? input.resource}. Create the ${isDirectoryMaterial(locator) ? "directory" : "file"} first, then run link-output again.`,
            );
          throw error;
        }
      }
      const basename =
        locator.kind === "path"
          ? nodePath.posix.basename(locator.target)
          : locator.kind === "uri"
            ? decodeURIComponent(nodePath.posix.basename(new URL(locator.uri).pathname))
            : "";
      const defaultName = basename && basename !== "." && basename !== ".." ? basename : "Output";
      let name = validateNodeName(input.name ?? defaultName, goal.path);
      if (input.name === undefined)
        for (let index = 2; await fs.exists(`${goal.path}/${name}`); index++)
          name = `${defaultName} ${index}`;
      if (locator.kind === "path") {
        const relative = nodePath.posix.relative(
          nodePath.posix.dirname(nodeNotePath(`${goal.path}/${name}`)),
          locator.target,
        );
        const encoded = relative.split("/").map(encodeURIComponent).join("/");
        descriptor.resource =
          (encoded.startsWith("../") ? encoded : `./${encoded}`) +
          (locator.directory && !encoded.endsWith("/") ? "/" : "") +
          locator.suffix;
      }
      let cardId = input.cardId;
      if (cardId) {
        let card: Record<string, unknown>;
        try {
          card = await readCardDocument(fs, cardId);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            throw new NodeWriteError("INVALID_INPUT", `Card ${cardId} does not exist.`);
          throw error;
        }
        if (card.diagnostic || card.status === "deprecated" || card.state !== "consumed")
          throw new NodeWriteError(
            "INVALID_INPUT",
            "Output response requires a current received Card",
          );
        const pinned = (
          await readCardGoalIds(fs, [{ cardId, sources: card.sources } as CardSourceInput])
        ).get(cardId)!;
        if (
          pinned.diagnostics.length ||
          ![goal, ...goalAncestors(goal, catalog.byId)].some((ancestor) =>
            pinned.goalIds.has(ancestor.nodeId),
          )
        )
          throw new NodeWriteError(
            "INVALID_INPUT",
            "Output response requires a Card source goal in the output's goal chain",
          );
      } else {
        const listed = await listCardDocuments(fs, { state: "consumed" });
        const candidates = listed.items.filter(
          (card) => !card.diagnostic && typeof card.returnTo === "string",
        );
        const reads = await Promise.all(
          candidates.map(async (card) => {
            const read = (await readCardDocument(fs, String(card.cardId))) as Record<
              string,
              unknown
            >;
            if (read.diagnostic || !Array.isArray(read.sources)) return undefined;
            return {
              cardId: String(card.cardId),
              sources: read.sources,
              receivedBy: read.receivedBy,
            } as CardSourceInput & { receivedBy?: string };
          }),
        );
        const cards = reads.filter((card) => card !== undefined);
        const goals = await readCardGoalIds(fs, cards);
        const related = cards.filter((card) => goals.get(card.cardId)!.goalIds.has(goalId));
        const matching = related.filter((card) => input.roleId && card.receivedBy === input.roleId);
        if (matching.length > 1)
          throw new NodeWriteError(
            "INVALID_INPUT",
            `Multiple incomplete Cards point to this goal: ${matching.map((card) => card.cardId).join(", ")}. Choose one with --card <id>.`,
          );
        if (matching.length === 1) cardId = matching[0]!.cardId;
        else if (related.length)
          throw new NodeWriteError(
            "INVALID_INPUT",
            "Incomplete received Cards point to this goal, but no explicit Role matches their receiver. Choose one with --card <id>.",
          );
      }
      const nodeId = await createNodeUnlocked(
        { fs, clock: { now: () => new Date().toISOString() }, tentName: "" },
        {
          parentPath: goal.path,
          name,
          type: "output",
          ...(tags.length ? { tags } : {}),
          resource: descriptor.resource,
          ...(cardId ? { sources: [{ resource: `/${cardRecordPath(cardId)}` }] } : {}),
        },
      );
      const path = `${goal.path}/${name}`,
        raw = await fs.readFile(nodeNotePath(path));
      const version =
        fs.history && (await hasDocumentHistory(fs))
          ? { commit: (await fs.history.currentCommit())!, path: nodeNotePath(path) }
          : undefined;
      return {
        nodeId,
        path,
        etag: contentEtag(raw),
        version,
        ...(cardId ? { cardId } : {}),
        ...(warnings.length ? { warnings } : {}),
      };
    },
    { operation: "node.output-link" },
  );
}
