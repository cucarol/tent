import { setTimeout as delay } from "node:timers/promises";
import { withTentMutation, type FsAdapter } from "../store/adapter.js";
import { parseFrontmatter, serializeFrontmatter } from "../base/frontmatter.js";
import { isCardId, isRoleId, makeCardId } from "../base/id.js";
import {
  CARDS_DIR,
  cardRecordPath,
  roleDocumentPath,
  ROLES_DIR,
  nodeNotePath,
} from "../base/paths.js";
import { documentLifecycle } from "../base/document-status.js";
import {
  materialLocator,
  isDirectoryMaterial,
  sourcesSchema,
  MaterialAddressError,
  type MaterialSource,
} from "../base/material.js";
import { isHistoryDocument } from "../store/document-history.js";
import { parseRoleDocument } from "../store/role-document.js";
import { canonicalDocumentReferences } from "./document-links.js";
import { assertSystemMaterial, systemMaterialPath } from "./material-target.js";
import { cardSourceIdentityError } from "./card-context.js";
import { loadNodeCatalog } from "./node-catalog.js";
import type { DocumentVersion } from "../store/history-port.js";
import { cardOrderKey } from "../base/card-order.js";
import { markdownMaterialHeading } from "../base/material-section.js";
import { NodeSectionError, selectSection } from "../base/markdown-section.js";

export type CardDocumentState = "pending" | "consumed" | "returned" | "closed";
type CardFields = Record<string, unknown> & {
  type: "card";
  id: string;
  schemaVersion: 3;
  sources: MaterialSource[];
  title?: string;
  target: string;
  returnTo?: string;
  result?: string;
  state: CardDocumentState;
  receivedBy?: string;
};
type CardDocument = {
  path: string;
  raw: string;
  body: string;
  data: CardFields;
  keyOrder: string[];
};
function invalid(message: string): never {
  throw new Error(message);
}
function cardPath(id: string) {
  if (!isCardId(id)) invalid("Invalid Card id");
  return cardRecordPath(id);
}
export function parseCardDocument(id: string, raw: string): CardDocument {
  const path = cardPath(id);
  let parsed: ReturnType<typeof parseFrontmatter>;
  try {
    parsed = parseFrontmatter(raw);
    sourcesSchema.parse(parsed.data.sources);
  } catch (error) {
    invalid(`Invalid Card metadata: ${error instanceof Error ? error.message : String(error)}`);
  }
  validateCardHeader(id, parsed.data);
  return {
    path,
    raw,
    body: parsed.body,
    data: parsed.data as CardFields,
    keyOrder: parsed.keyOrder,
  };
}
function validateCardHeader(id: string, data: Record<string, unknown>) {
  if (data.type !== "card" || data.id !== id || data.schemaVersion !== 3)
    invalid("Expected a Card v3 document with matching id");
  if (data.status === "draft")
    invalid("A Card cannot have draft status; decide the task before publishing it");
  if (documentLifecycle(data).status === null) invalid("Unsupported Card status");
  if (data.title !== undefined && (typeof data.title !== "string" || !data.title.trim()))
    invalid("Card title must be nonempty text");
  if (data.target === undefined) invalid("Card needs a target Role");
  if (typeof data.target !== "string" || !isRoleId(data.target))
    invalid("Card target must be an explicit Role id");
  if (
    data.returnTo !== undefined &&
    (typeof data.returnTo !== "string" || !isRoleId(data.returnTo))
  )
    invalid("Card returnTo must be an explicit Role id");
  if (data.returnTo !== undefined && data.returnTo === data.target)
    invalid("Card returnTo must differ from target");
  if (!["pending", "consumed", "returned", "closed"].includes(String(data.state)))
    invalid("Invalid Card state");
  if (
    data.receivedBy !== undefined &&
    (data.state === "pending" || typeof data.receivedBy !== "string" || !isRoleId(data.receivedBy))
  )
    invalid("Card state and receivedBy disagree");
  if (data.state !== "pending" && data.receivedBy !== data.target)
    invalid("Targeted Card must be received with its Role");
  if (
    data.returnTo !== undefined &&
    data.state !== "pending" &&
    (data.receivedBy === undefined || data.receivedBy === data.returnTo)
  )
    invalid("A Card with returnTo must be received by a different Role");
  if (data.state === "returned" || data.state === "closed") {
    if (!data.returnTo || !data.receivedBy)
      invalid("Returned Card requires returnTo and receivedBy");
    validateResult(data.result);
  } else if (data.result !== undefined) invalid("Only returned or closed Cards have a result");
}
function validateResult(result: unknown): asserts result is string {
  if (typeof result !== "string" || !result.trim() || /[\r\n\v\f\u0085\u2028\u2029]/u.test(result))
    invalid("Card result must be nonempty single-line text");
  if ([...result].length > 200)
    invalid(
      "Card result exceeds 200 characters; put details in a Node and include its Node id in the result",
    );
}
function requireInput(card: CardDocument) {
  if (!card.body.trim() && !card.data.sources.length) invalid("Card needs prompt text or sources");
}
async function requireUnusedId(fs: FsAdapter, id: string) {
  const history = await historyOf(fs);
  if ((await fs.exists(cardPath(id))) || (await history.pathVersions(cardPath(id))).first)
    invalid("Card id already exists in files or history; create a new identity");
}
async function historyOf(fs: FsAdapter) {
  if (!(await fs.history.available()))
    throw new Error("Card operations require independent Tent history");
  return fs.history;
}
async function roleAvailable(fs: FsAdapter, roleId: string) {
  try {
    if (!isRoleId(roleId)) throw new Error("Invalid Role id");
    const role = parseRoleDocument(roleId, await fs.readFile(roleDocumentPath(roleId)));
    const status = documentLifecycle(parseFrontmatter(role.raw).data).status;
    if (status !== "stable" && status !== "draft") throw new Error("Role is not current");
  } catch (error) {
    throw new Error(`Role unavailable: ${roleId}: ${String(error)}`);
  }
}

function internalSourcePath(fs: FsAdapter, owner: string, source: MaterialSource) {
  const locator = materialLocator(source.resource, owner, true);
  const file = !isDirectoryMaterial(locator)
    ? systemMaterialPath(locator, fs.workspaceRoot)
    : undefined;
  return file &&
    file !== ".." &&
    !file.startsWith("../") &&
    !file.startsWith(CARDS_DIR + "/") &&
    isHistoryDocument(file)
    ? file
    : undefined;
}

/** Sources are addresses the receiver reads live; Node and Role sources must still parse. */
async function checkSources(fs: FsAdapter, owner: string, sources: MaterialSource[]) {
  for (const [i, source] of sources.entries()) {
    try {
      await assertSystemMaterial(fs, materialLocator(source.resource, owner, true));
    } catch (error) {
      throw new MaterialAddressError(
        `Invalid sources[${i}].resource: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const file = internalSourcePath(fs, owner, source);
    if (!file) continue;
    if (fs.invalidNodeEdits?.has(file))
      invalid(`Invalid Node source: ${file}: ${fs.invalidNodeEdits.get(file)}`);
    const raw = await fs.readFile(file);
    const error = cardSourceIdentityError(file, raw, parseFrontmatter(raw).data);
    if (error) invalid(error);
  }
}

/**
 * Advisory: a Node or Role source that selects a section its current text lacks.
 * `sources` are the stored addresses; `typed` names each one as the sender wrote it.
 */
export async function cardSourceSectionWarnings(
  fs: FsAdapter,
  owner: string,
  sources: MaterialSource[],
  typed: readonly string[] = sources.map((source) => source.resource),
) {
  const warnings: string[] = [];
  for (const [i, source] of sources.entries()) {
    const heading = markdownMaterialHeading(materialLocator(source.resource, owner, true));
    const file = internalSourcePath(fs, owner, source);
    if (heading === undefined || !file) continue;
    try {
      selectSection(parseFrontmatter(await fs.readFile(file)).body, heading);
    } catch (error) {
      if (!(error instanceof NodeSectionError)) throw error;
      warnings.push(
        `Warning: source ${JSON.stringify(typed[i] ?? source.resource)} selects an unavailable section: ${error.message}; the Card keeps it.`,
      );
    }
  }
  return warnings;
}

/**
 * Where each source is now. A Node source means the Node at that address when the Card was
 * published; when that Node has moved since, its id leads to the current file, and when it is
 * gone the source names its id as gone rather than whatever now has its path.
 */
async function currentSources(fs: FsAdapter, card: CardDocument, published: DocumentVersion) {
  let catalog: ReturnType<typeof loadNodeCatalog> | undefined;
  return Promise.all(
    card.data.sources.map(async ({ resource }) => {
      const file = internalSourcePath(fs, card.path, { resource });
      if (!file || file.startsWith(ROLES_DIR + "/")) return { resource, file };
      const idIn = async (read: Promise<string>) => {
        try {
          return parseFrontmatter(await read).data.id;
        } catch {
          return undefined;
        }
      };
      const id = await idIn(fs.history.read({ commit: published.commit, path: file }));
      if (typeof id !== "string") return { resource, file };
      if ((await idIn(fs.readFrontmatter(file))) === id) return { resource, file };
      const node = (await (catalog ??= loadNodeCatalog(fs))).byId.get(id);
      return node ? { resource, file: nodeNotePath(node.path) } : { resource, gone: id };
    }),
  );
}

async function checkedCard(fs: FsAdapter, id: string) {
  const path = cardPath(id);
  const current = parseCardDocument(id, await fs.readFile(path));
  const history = await historyOf(fs);
  const versions = await history.pathVersions(path);
  if (!versions.first || !versions.latest)
    throw new Error("Card has no retained publication; create a Card through Tent");
  return { current, publishedVersion: versions.first, version: versions.latest, history };
}

export function createCardDocument(
  fs: FsAdapter,
  input: {
    cardId?: string;
    prompt: string;
    sources?: MaterialSource[];
    title?: string;
    target: string;
    returnTo?: string;
  },
) {
  return withTentMutation(
    fs,
    async () => {
      const history = await historyOf(fs),
        id = input.cardId ?? makeCardId(),
        path = cardPath(id);
      await requireUnusedId(fs, id);
      const fields = {
        type: "card",
        id,
        schemaVersion: 3,
        sources: input.sources ?? [],
        ...(input.title !== undefined ? { title: input.title } : {}),
        target: input.target,
        ...(input.returnTo !== undefined ? { returnTo: input.returnTo } : {}),
        state: "pending",
      };
      const prompt = await canonicalDocumentReferences(fs, path, fields, input.prompt);
      const card = parseCardDocument(id, serializeFrontmatter(fields, prompt));
      requireInput(card);
      await roleAvailable(fs, card.data.target);
      if (card.data.returnTo) await roleAvailable(fs, card.data.returnTo);
      await checkSources(fs, path, card.data.sources);
      const raw = serializeFrontmatter(card.data, card.body, card.keyOrder);
      await fs.writeFile(path, raw);
      const captured = await history.captureUnlocked([{ path, raw }], {
        operation: "card.create",
      });
      return {
        cardId: id,
        path,
        state: "pending" as const,
        target: card.data.target,
        returnTo: card.data.returnTo,
        sources: card.data.sources,
        version: captured.versions[0]!,
      };
    },
    { operation: "card.create" },
  );
}

/** Cancel a published task without altering its recorded input or reception. */
export function deprecateCardDocument(fs: FsAdapter, id: string) {
  return withTentMutation(
    fs,
    async () => {
      const { current, history, version } = await checkedCard(fs, id);
      let savedVersion = version;
      if (current.data.status !== "deprecated") {
        const raw = serializeFrontmatter(
          { ...current.data, status: "deprecated" },
          current.body,
          current.keyOrder,
        );
        await fs.writeFile(current.path, raw);
        savedVersion = (
          await history.captureUnlocked([{ path: current.path, raw }], {
            operation: "card.deprecate",
          })
        ).versions[0]!;
      }
      return {
        cardId: id,
        path: current.path,
        state: current.data.state,
        target: current.data.target,
        receivedBy: current.data.receivedBy,
        result: current.data.result,
        status: "deprecated" as const,
        version: savedVersion,
      };
    },
    { operation: "card.deprecate" },
  );
}

function deprecatedCardNotice(card: CardDocument) {
  return documentLifecycle(card.data).status === "deprecated"
    ? { notice: "This Card is deprecated; its task was cancelled." }
    : {};
}

export function takeCardDocument(fs: FsAdapter, id: string, roleId: string) {
  return withTentMutation(
    fs,
    async () => {
      const { current, history, publishedVersion } = await checkedCard(fs, id);
      await roleAvailable(fs, roleId);
      const receivingReturn = current.data.state === "returned" || current.data.state === "closed";
      const target = receivingReturn ? current.data.returnTo : current.data.target;
      if (target !== roleId)
        throw new Error(`Card ${id} is addressed to ${target}; you took it as ${roleId}.`);
      const state = current.data.state;
      const nextState = receivingReturn ? "closed" : "consumed";
      const replayed = state === nextState;
      const raw =
        state === nextState
          ? current.raw
          : serializeFrontmatter(
              {
                ...current.data,
                state: nextState,
                ...(!receivingReturn ? { receivedBy: roleId } : {}),
              },
              current.body,
              current.keyOrder,
            );
      const metadata = {
        sources: await currentSources(fs, current, publishedVersion),
        title: current.data.title,
        target: current.data.target,
        state: nextState,
        receivedBy: receivingReturn ? current.data.receivedBy : roleId,
        returnTo: current.data.returnTo,
        result: current.data.result,
        replayed,
        ...documentLifecycle(current.data),
        ...deprecatedCardNotice(current),
      };
      if (raw !== current.raw) await fs.writeFile(current.path, raw);
      const savedVersion = (
        await history.captureUnlocked([{ path: current.path, raw }], {
          operation: "card.take",
        })
      ).versions[0];
      return {
        cardId: id,
        path: current.path,
        ...metadata,
        version: savedVersion,
        text: current.body,
      };
    },
    { operation: "card.take" },
  );
}

/** Return exactly one result; the receiving Role remains the result's author. */
export function returnCardDocument(
  fs: FsAdapter,
  id: string,
  input: { result: string; roleId: string },
) {
  return withTentMutation(
    fs,
    async () => {
      validateResult(input.result);
      const { current, history } = await checkedCard(fs, id);
      await roleAvailable(fs, input.roleId);
      if (!current.data.returnTo)
        throw new Error(`Card ${id} has no returnTo; taking it completed it.`);
      if (current.data.state === "pending")
        throw new Error(`Card ${id} is still pending; take it with --role <role-id> first.`);
      if (current.data.receivedBy !== input.roleId)
        throw new Error(
          `${current.data.receivedBy} took Card ${id}; return it with --role ${current.data.receivedBy}.`,
        );
      if (current.data.result !== undefined && current.data.result !== input.result)
        throw new Error(
          `Card ${id} was already returned: ${current.data.result}. Put corrections in a Node, or send a new Card.`,
        );
      const replayed = current.data.state !== "consumed";
      const fields =
        current.data.state === "consumed"
          ? { ...current.data, state: "returned" as const, result: input.result }
          : current.data;
      const raw =
        fields === current.data
          ? current.raw
          : serializeFrontmatter(fields, current.body, current.keyOrder);
      if (raw !== current.raw) await fs.writeFile(current.path, raw);
      const captured = await history.captureUnlocked([{ path: current.path, raw }], {
        operation: "card.return",
      });
      return {
        cardId: id,
        path: current.path,
        state: fields.state,
        target: fields.target,
        returnTo: fields.returnTo,
        receivedBy: fields.receivedBy,
        result: fields.result,
        replayed,
        version: captured.versions[0],
      };
    },
    { operation: "card.return" },
  );
}

type WatchedCard = {
  cardId: string;
  title?: string;
  state?: "returned";
  receivedBy?: string;
  result?: string;
};

/** Wait for published pending input or returned results; idle polls read only the current retained event. */
export async function watchCardDocuments(
  fs: FsAdapter,
  roleId: string,
  timeoutSeconds?: number,
): Promise<WatchedCard[]> {
  if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0))
    throw new Error("--timeout must be a nonnegative number of seconds");
  const deadline =
    performance.now() + (timeoutSeconds === undefined ? Infinity : timeoutSeconds * 1000);
  // A wrong Role fails at once; polling below also sees a Role retired while waiting.
  await roleAvailable(fs, roleId);
  let observed: string | undefined;
  let retrying = false;
  for (;;) {
    try {
      await roleAvailable(fs, roleId);
      const history = await historyOf(fs);
      const head = await history.currentCommit();
      if (head && head !== observed) {
        const selected: CardDocument[] = [];
        for (const [path, raw] of await history.readDirectory(head, CARDS_DIR)) {
          const name = path.slice(CARDS_DIR.length + 1);
          const id = name.slice(0, -3);
          if (!name.endsWith(".md") || !isCardId(id)) continue;
          const card = parseCardDocument(id, raw);
          if (
            ((card.data.state === "pending" && card.data.target === roleId) ||
              (card.data.state === "returned" && card.data.returnTo === roleId)) &&
            documentLifecycle(card.data).status !== "deprecated"
          )
            selected.push(card);
        }
        const { published: times, returned: returnedTimes } = await history.cardQueueTimes(
          head,
          selected.map((card) => card.path),
        );
        const group = (card: CardDocument) => (card.data.state === "returned" ? 1 : 0);
        selected.sort((a, b) => {
          const lane = group(a) - group(b);
          if (lane) return lane;
          const key = (card: CardDocument) =>
            card.data.state === "returned"
              ? (returnedTimes.get(card.path) ?? "~")
              : cardOrderKey(card.data.id, times.get(card.path)!);
          const ak = key(a),
            bk = key(b);
          return ak < bk ? -1 : ak > bk ? 1 : a.data.id < b.data.id ? -1 : 1;
        });
        const items: WatchedCard[] = selected.map((card) => ({
          cardId: card.data.id,
          ...(card.data.title ? { title: card.data.title } : {}),
          ...(card.data.state === "returned"
            ? {
                state: "returned" as const,
                receivedBy: card.data.receivedBy,
                result: card.data.result,
              }
            : {}),
        }));
        // Failed reads must leave this head unobserved for the next poll.
        observed = head;
        if (items.length) return items;
      }
      retrying = false;
    } catch (error) {
      // A long wait survives one failed poll; two in a row are a real error.
      if (retrying || performance.now() >= deadline) throw error;
      retrying = true;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) return [];
    await delay(Math.min(3000, remaining));
  }
}

function completedCard(data: Record<string, unknown>): boolean {
  return (
    documentLifecycle(data).status === "deprecated" ||
    data.state === "closed" ||
    (data.state === "consumed" && data.returnTo === undefined)
  );
}

/** Routine reads skip Cards completed in Tent history, regardless of subsequent native edits. */
export async function completedCardPaths(fs: FsAdapter): Promise<ReadonlySet<string>> {
  if (!(await fs.history.available())) return new Set();
  return fs.history.completedCardPaths((file, raw) => {
    try {
      const data = parseFrontmatter(raw).data;
      validateCardHeader(file.slice(CARDS_DIR.length + 1, -3), data);
      return completedCard(data);
    } catch {
      return false;
    }
  });
}

function forRole(data: Record<string, unknown>, roleId: string, waiting?: boolean) {
  if (!waiting)
    return data.state === "pending"
      ? data.target === roleId
      : data.receivedBy === roleId || data.returnTo === roleId;
  return (
    (data.state === "pending" && data.target === roleId) ||
    (data.state === "consumed" && data.receivedBy === roleId && data.returnTo !== undefined) ||
    (data.state === "returned" && data.returnTo === roleId)
  );
}

export async function listCardDocuments(
  fs: FsAdapter,
  options: {
    roleId?: string;
    /** With roleId: Cards waiting for that Role to take, return or read a result. */
    waiting?: boolean;
    state?: CardDocumentState;
    includeDeprecated?: boolean;
  } = {},
) {
  const read = async () => ({ items: await listCardHeaders(fs, options) });
  return fs.observationScope(read);
}

async function listCardHeaders(
  fs: FsAdapter,
  options: NonNullable<Parameters<typeof listCardDocuments>[1]>,
) {
  if (options.roleId) await roleAvailable(fs, options.roleId);
  const items: Array<Record<string, unknown>> = [];
  const selected: Array<Record<string, unknown> & { path: string }> = [];
  const entries = (await fs.exists(CARDS_DIR))
    ? (await fs.listDir(CARDS_DIR)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    : [];
  let nextHeader = 0;
  await Promise.all(
    Array.from({ length: Math.min(16, entries.length) }, async () => {
      for (;;) {
        const entry = entries[nextHeader++];
        if (!entry) return;
        const id = entry.name.slice(0, -3);
        if (entry.isDir || !entry.name.endsWith(".md") || !isCardId(id)) continue;
        const path = cardPath(id);
        try {
          const data = parseFrontmatter(await fs.readFrontmatter(path)).data;
          validateCardHeader(id, data);
          const state = data.state;
          if (!options.includeDeprecated && documentLifecycle(data).status === "deprecated")
            continue;
          if (options.state && state !== options.state) continue;
          if (options.roleId && !forRole(data, options.roleId, options.waiting)) continue;
          const item = {
            cardId: id,
            path,
            title: data.title,
            state,
            target: data.target,
            receivedBy: data.receivedBy,
            returnTo: data.returnTo,
            result: data.result,
            ...documentLifecycle(data),
          };
          items.push(item);
          selected.push(item);
        } catch {
          items.push({
            cardId: id,
            path,
            diagnostic: "Card header unavailable; run tent workspace check",
          });
        }
      }
    }),
  );
  if (selected.length && (await fs.history.available())) {
    const times = await fs.history.firstCommitTimes(selected.map((item) => item.path));
    for (const item of selected) {
      const time = times.get(item.path);
      if (!time) continue;
      item.publishedAt = time;
      item.orderKey = cardOrderKey(String(item.cardId), time);
    }
  }
  // A header alone is never evidence of publication.
  const visible = items.filter((item) => item.diagnostic || item.publishedAt);
  if (options.waiting) {
    const lane = (item: Record<string, unknown>) =>
      item.diagnostic ? 3 : item.state === "pending" ? 0 : item.state === "consumed" ? 1 : 2;
    return visible.sort((a, b) => {
      const order = lane(a) - lane(b);
      if (order) return order;
      const ak = String(a.orderKey ?? a.cardId),
        bk = String(b.orderKey ?? b.cardId);
      return ak < bk ? -1 : ak > bk ? 1 : 0;
    });
  }
  return visible.sort((a, b) => {
    if (options.state === "pending" && !a.diagnostic && !b.diagnostic) {
      const queue = (item: Record<string, unknown>) =>
        item.target === options.roleId ? "" : String(item.target ?? "~");
      const aq = queue(a),
        bq = queue(b);
      if (aq !== bq) return aq < bq ? -1 : 1;
      if (a.orderKey !== b.orderKey) return String(a.orderKey) < String(b.orderKey) ? -1 : 1;
    }
    const aTime = String(a.publishedAt ?? ""),
      bTime = String(b.publishedAt ?? "");
    if (aTime !== bTime) return aTime > bTime ? -1 : 1;
    const aId = String(a.cardId),
      bId = String(b.cardId);
    return aId < bId ? -1 : aId > bId ? 1 : 0;
  });
}
