import { hasDocumentHistory } from "../store/history-port.js";
import { isDeepStrictEqual } from "node:util";
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
import { contentEtag } from "../base/etag.js";
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
import { canonicalSha256 } from "../base/canonical-digest.js";
import { canonicalDocumentReferences } from "./document-links.js";
import { assertSystemMaterial, systemMaterialPath } from "./material-target.js";
import { cardSourceIdentityError } from "./card-context.js";
import { loadNodeCatalog } from "./node-catalog.js";
import type { DocumentVersion } from "../store/history-port.js";
import { uncapturedChecker } from "./retained-read.js";
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
  target?: string;
  returnTo?: string;
  result?: string;
  state: CardDocumentState;
  receivedBy?: string;
};
type CardDocument = {
  path: string;
  raw: string;
  etag: string;
  body: string;
  data: CardFields;
  keyOrder: string[];
};
export class CardDocumentError extends Error {
  constructor(
    readonly code:
      | "INVALID_DOCUMENT"
      | "UNPUBLISHED"
      | "INPUT_CHANGED"
      | "STATE_CHANGED"
      | "ROLE_UNAVAILABLE"
      | "RECEPTION_CONFLICT",
    message: string,
    readonly details?: {
      current: { etag: string; state: CardDocumentState; target?: string; receivedBy?: string };
    },
    readonly cause?: unknown,
  ) {
    super(message);
  }
}
function invalid(message: string): never {
  throw new CardDocumentError("INVALID_DOCUMENT", message);
}
function cardPath(id: string) {
  if (!isCardId(id)) invalid("Invalid Card id");
  return cardRecordPath(id);
}
export function parseCardDocument(id: string, raw: string): CardDocument {
  let parsed: ReturnType<typeof parseFrontmatter>;
  try {
    parsed = parseFrontmatter(raw);
  } catch (error) {
    invalid(`Invalid Card metadata: ${String(error)}`);
  }
  return cardFromParsed(id, raw, parsed);
}
function cardFromParsed(
  id: string,
  raw: string,
  parsed: ReturnType<typeof parseFrontmatter>,
): CardDocument {
  const path = cardPath(id);
  try {
    sourcesSchema.parse(parsed.data.sources);
  } catch (error) {
    invalid(`Invalid Card metadata: ${String(error)}`);
  }
  const data = parsed.data;
  validateCardHeader(id, data);
  return {
    path,
    raw,
    etag: contentEtag(raw),
    body: parsed.body,
    data: data as CardFields,
    keyOrder: parsed.keyOrder,
  };
}
function validateCardHeader(id: string, data: Record<string, unknown>) {
  if (data.type !== "card" || data.id !== id || data.schemaVersion !== 3)
    invalid("Expected a Card v3 document with matching id");
  if (data.status === "draft")
    invalid("A Card cannot have draft status; decide the task before publishing it");
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
function inputOf(document: CardDocument) {
  const { state, receivedBy, result, status, target, ...fields } = document.data;
  return { fields, body: document.body };
}
function stateOf(document: CardDocument) {
  return {
    state: document.data.state,
    receivedBy: document.data.receivedBy,
    result: document.data.result,
    target: document.data.target,
    status: document.data.status,
  };
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
function cardConflict(
  card: CardDocument,
  code: "STATE_CHANGED" | "RECEPTION_CONFLICT",
  message: string,
): never {
  throw new CardDocumentError(code, message, { current: { etag: card.etag, ...stateOf(card) } });
}
async function checkUnchanged(fs: FsAdapter, card: CardDocument) {
  if ((await fs.readFile(card.path)) !== card.raw)
    throw new CardDocumentError(
      "STATE_CHANGED",
      "Card changed during checks; reread before saving",
    );
}
async function historyOf(fs: FsAdapter) {
  if (!fs.history || !(await fs.history.available()))
    throw new CardDocumentError("UNPUBLISHED", "Card operations require independent Tent history");
  return fs.history;
}
async function roleAvailable(
  fs: FsAdapter,
  roleId: string,
  options: { headerOnly?: boolean; confirmMissing?: boolean } = {},
) {
  try {
    if (!isRoleId(roleId)) throw new Error("Invalid Role id");
    const path = roleDocumentPath(roleId);
    const read = () =>
      options.headerOnly !== false && fs.readFrontmatter
        ? fs.readFrontmatter(path)
        : fs.readFile(path);
    let raw: string;
    try {
      raw = await read();
    } catch (error) {
      // A missing Role remains fatal. Confirm one ENOENT so a replacement's
      // momentary absence is not mistaken for a genuinely deleted Role.
      if (!options.confirmMissing || (error as { code?: string })?.code !== "ENOENT") throw error;
      raw = await read();
    }
    const role = parseRoleDocument(roleId, raw);
    const status = documentLifecycle(parseFrontmatter(role.raw).data).status;
    if (status !== "stable" && status !== "draft") throw new Error("Role is not current");
  } catch (error) {
    throw new CardDocumentError(
      "ROLE_UNAVAILABLE",
      `Role unavailable: ${roleId}: ${String(error)}`,
      undefined,
      error,
    );
  }
}

function validateSource(file: string, raw: string, data = parseFrontmatter(raw).data) {
  const error = cardSourceIdentityError(file, raw, data);
  if (error) invalid(error);
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
    validateSource(
      file,
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await fs.readBinary(file)),
    );
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
      if (!file || file.startsWith(ROLES_DIR + "/") || !fs.history) return { resource, file };
      const idIn = async (read: Promise<string>) => {
        try {
          return parseFrontmatter(await read).data.id;
        } catch {
          return undefined;
        }
      };
      const id = await idIn(fs.history.read({ commit: published.commit, path: file }));
      if (typeof id !== "string") return { resource, file };
      if ((await idIn(fs.readFrontmatter ? fs.readFrontmatter(file) : fs.readFile(file))) === id)
        return { resource, file };
      const node = (await (catalog ??= loadNodeCatalog(fs))).byId.get(id);
      return node ? { resource, file: nodeNotePath(node.path) } : { resource, gone: id };
    }),
  );
}

type CardAction =
  { kind: "take"; roleId?: string } | { kind: "return"; roleId?: string; result: string };
async function checkedCard(fs: FsAdapter, id: string, action?: CardAction) {
  const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    await fs.readBinary(cardPath(id)),
  );
  const current = parseCardDocument(id, raw),
    history = await historyOf(fs);
  const versions = await history.pathVersions(current.path);
  if (!versions.first || !versions.latest)
    throw new CardDocumentError(
      "UNPUBLISHED",
      "Card has no retained publication; create a Card through Tent",
    );
  const retained = await history.readVersions([versions.first, versions.latest]);
  if (retained[0] instanceof Error) throw retained[0];
  if (retained[1] instanceof Error) throw retained[1];
  const published = parseCardDocument(id, retained[0]!.raw);
  const latest = parseCardDocument(id, retained[1]!.raw);
  let next: ReturnType<typeof stateOf> | undefined;
  if (action?.kind === "take" && latest.data.state === "pending")
    next = { ...stateOf(latest), state: "consumed", receivedBy: action.roleId };
  else if (
    action?.kind === "take" &&
    latest.data.state === "returned" &&
    latest.data.returnTo === action.roleId
  )
    next = { ...stateOf(latest), state: "closed" };
  else if (
    action?.kind === "return" &&
    latest.data.state === "consumed" &&
    latest.data.returnTo &&
    latest.data.receivedBy === action.roleId
  )
    next = { ...stateOf(latest), state: "returned", result: action.result };
  const recovery = next !== undefined && isDeepStrictEqual(stateOf(current), next);
  validateRetainedCard(current, published, latest, recovery);
  return { current, publishedVersion: versions.first, version: versions.latest, history, recovery };
}
function validateRetainedCard(
  current: CardDocument,
  published: CardDocument,
  latest: CardDocument,
  recovery = false,
) {
  requireInput(published);
  if (published.data.state !== "pending") invalid("Initial Card publication is not pending");
  if (
    !isDeepStrictEqual(inputOf(current), inputOf(published)) ||
    !isDeepStrictEqual(inputOf(latest), inputOf(published))
  )
    throw new CardDocumentError(
      "INPUT_CHANGED",
      "Published Card input changed; restore it and edit the requirement Nodes",
    );
  if (!recovery && !isDeepStrictEqual(stateOf(current), stateOf(latest)))
    throw new CardDocumentError(
      "STATE_CHANGED",
      "Card management fields differ from retained state; inspect the diff before reconciling",
    );
}

export function createCardDocument(
  fs: FsAdapter,
  input: {
    cardId?: string;
    prompt: string;
    sources?: MaterialSource[];
    title?: string;
    target?: string;
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
      if (typeof input.prompt !== "string") invalid("Card prompt must be text");
      if (input.target === undefined) invalid("Card needs a target Role");
      const sources = input.sources ?? [];
      sourcesSchema.parse(sources);
      const fields = {
        type: "card",
        id,
        schemaVersion: 3,
        sources,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.target !== undefined ? { target: input.target } : {}),
        ...(input.returnTo !== undefined ? { returnTo: input.returnTo } : {}),
        state: "pending",
      };
      const prompt = await canonicalDocumentReferences(fs, path, fields, input.prompt);
      const card = parseCardDocument(id, serializeFrontmatter(fields, prompt));
      requireInput(card);
      if (card.data.target) await roleAvailable(fs, card.data.target);
      if (card.data.returnTo) await roleAvailable(fs, card.data.returnTo);
      await checkSources(fs, path, card.data.sources);
      const raw = serializeFrontmatter(card.data, card.body, card.keyOrder);
      await fs.writeFile(path, raw);
      const captured = await history
        .captureUnlocked([{ path, raw }], { operation: "card.create" })
        .catch((error) => {
          throw new Error(
            `Card file may be saved but is not confirmed published; inspect it before retrying: ${String(error)}`,
          );
        });
      return {
        cardId: id,
        path,
        state: "pending" as const,
        target: card.data.target,
        returnTo: card.data.returnTo,
        sources: card.data.sources,
        etag: contentEtag(raw),
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
      const raw =
        current.data.status === "deprecated"
          ? current.raw
          : serializeFrontmatter(
              { ...current.data, status: "deprecated" },
              current.body,
              current.keyOrder,
            );
      await checkUnchanged(fs, current);
      let savedVersion = version;
      if (raw !== current.raw) {
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
        etag: contentEtag(raw),
        ...stateOf(current),
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

export function takeCardDocument(
  fs: FsAdapter,
  id: string,
  roleId: string | undefined = undefined,
) {
  return withTentMutation(
    fs,
    async () => {
      const { current, history, publishedVersion, recovery } = await checkedCard(fs, id, {
        kind: "take",
        roleId,
      });
      if (roleId !== undefined) await roleAvailable(fs, roleId);
      const status = documentLifecycle(current.data).status;
      if (status !== "stable" && status !== "deprecated")
        throw new CardDocumentError("RECEPTION_CONFLICT", "Card is not current");
      const receivingReturn = current.data.state === "returned" || current.data.state === "closed";
      const target = receivingReturn ? current.data.returnTo : current.data.target;
      if (target !== roleId)
        throw new CardDocumentError(
          "RECEPTION_CONFLICT",
          roleId === undefined
            ? `Card ${id} is addressed to ${target}; take it with --role ${target}.`
            : `Card ${id} is addressed to ${target}; you took it as ${roleId}.`,
        );
      const state = current.data.state;
      const nextState = receivingReturn ? "closed" : "consumed";
      const replayed = state === nextState && !recovery;
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
      // Qualification/history reads above can yield to an external editor. Do not let
      // the filesystem writer adopt those newer bytes as the basis for this decision.
      if ((await fs.readFile(current.path)) !== current.raw)
        throw new CardDocumentError(
          "STATE_CHANGED",
          "Card changed during reception checks; reread before continuing",
        );
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
      if (!input.roleId)
        throw new CardDocumentError(
          "RECEPTION_CONFLICT",
          "Return requires --role role-ID, the Role that took the Card.",
        );
      const { current, history, recovery } = await checkedCard(fs, id, {
        kind: "return",
        ...input,
      });
      if (input.roleId !== undefined) await roleAvailable(fs, input.roleId);
      if (documentLifecycle(current.data).status === null)
        cardConflict(current, "RECEPTION_CONFLICT", "Card is not current");
      if (!current.data.returnTo)
        cardConflict(
          current,
          "RECEPTION_CONFLICT",
          `Card ${id} has no returnTo; taking it completed it.`,
        );
      if (current.data.state === "pending")
        cardConflict(
          current,
          "RECEPTION_CONFLICT",
          `Card ${id} is still pending; take it with --role <role-id> first.`,
        );
      if (current.data.receivedBy !== input.roleId)
        cardConflict(
          current,
          "RECEPTION_CONFLICT",
          `${current.data.receivedBy} took Card ${id}; return it with --role ${current.data.receivedBy}.`,
        );
      if (current.data.result !== undefined && current.data.result !== input.result)
        cardConflict(
          current,
          "RECEPTION_CONFLICT",
          `Card ${id} was already returned: ${current.data.result}. Put corrections in a Node, or send a new Card.`,
        );
      const replayed = current.data.state !== "consumed" && !recovery;
      const fields =
        current.data.state === "consumed"
          ? { ...current.data, state: "returned" as const, result: input.result }
          : current.data;
      const raw =
        fields === current.data
          ? current.raw
          : serializeFrontmatter(fields, current.body, current.keyOrder);
      await checkUnchanged(fs, current);
      if (raw !== current.raw) await fs.writeFile(current.path, raw);
      const captured = await history.captureUnlocked([{ path: current.path, raw }], {
        operation: "card.return",
      });
      return {
        cardId: id,
        path: current.path,
        etag: contentEtag(raw),
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

function retryableWatchRead(error: unknown): boolean {
  const roleError = error instanceof CardDocumentError && error.code === "ROLE_UNAVAILABLE";
  const code = ((roleError ? error.cause : error) as { code?: string } | undefined)?.code;
  // roleAvailable already confirmed a missing Role; only inbox ENOENT retries.
  return (
    code === "SOURCE_CHANGED" ||
    code === "EPERM" ||
    code === "EACCES" ||
    code === "EBUSY" ||
    (!roleError && code === "ENOENT")
  );
}
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
  let observed: string | null | undefined;
  let retrying = false;
  for (;;) {
    try {
      // Watch must not populate the adapter's persistent frontmatter cache.
      // Check even an unchanged inbox, so native Role deletion/retirement is seen.
      await roleAvailable(fs, roleId, { headerOnly: false, confirmMissing: true });
      const history = await historyOf(fs);
      const head = await history.currentCommit();
      if (head !== observed) {
        const selected: CardDocument[] = [];
        for (const [path, raw] of head ? await history.readDirectory(head, CARDS_DIR) : []) {
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
        const { published: times, returned: returnedTimes } = head
          ? await history.cardQueueTimes(
              head,
              selected.map((card) => card.path),
            )
          : { published: new Map<string, string>(), returned: new Map<string, string>() };
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
      // One failed poll may straddle a replacement. Repeated failures are real
      // errors, not an indefinitely silent watcher with a broken inbox.
      if (retrying || !retryableWatchRead(error) || performance.now() >= deadline) throw error;
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
  if (!fs.history || !(await hasDocumentHistory(fs))) return new Set();
  try {
    return await fs.history.completedCardPaths((file, raw) => {
      try {
        const data = parseFrontmatter(raw).data;
        validateCardHeader(file.slice(CARDS_DIR.length + 1, -3), data);
        return completedCard(data);
      } catch {
        return false;
      }
    });
  } catch {
    // Unreadable history must leave ordinary header and publication diagnostics visible.
    return new Set();
  }
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

export async function listCardDocumentHeaders(
  fs: FsAdapter,
  options: {
    cardIds?: readonly string[];
    roleId?: string;
    /** With roleId: Cards waiting for that Role to take, return or read a result. */
    waiting?: boolean;
    state?: CardDocumentState;
    includeDeprecated?: boolean;
    uncaptured?: boolean;
    unfinishedOnly?: boolean;
  } = {},
) {
  if (options.roleId) await roleAvailable(fs, options.roleId);
  const cardIds = options.cardIds ? new Set(options.cardIds) : undefined;
  const items: Array<Record<string, unknown>> = [];
  const selected: Array<Record<string, unknown> & { path: string }> = [];
  const sourceSets = new Map<string, MaterialSource[]>();
  const sourceErrors = new Map<string, string>();
  const isUncaptured = options.uncaptured ? await uncapturedChecker(fs) : undefined;
  const completed = options.unfinishedOnly ? await completedCardPaths(fs) : undefined;
  const entries = (await fs.exists(CARDS_DIR))
    ? (await fs.listDir(CARDS_DIR))
        .filter((entry) => !completed?.has(`${CARDS_DIR}/${entry.name}`))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    : [];
  let nextHeader = 0;
  await Promise.all(
    Array.from({ length: Math.min(16, entries.length) }, async () => {
      for (;;) {
        const entry = entries[nextHeader++];
        if (!entry) return;
        const id = entry.name.slice(0, -3);
        if (entry.isDir || !entry.name.endsWith(".md") || !isCardId(id)) continue;
        if (cardIds && !cardIds.has(id)) continue;
        const path = cardPath(id);
        let uncaptured = false;
        try {
          const observed =
            isUncaptured && fs.readFrontmatterWithFingerprint
              ? await fs.readFrontmatterWithFingerprint(path)
              : undefined;
          const raw =
            observed?.content ??
            (!isUncaptured && fs.readFrontmatter
              ? await fs.readFrontmatter(path)
              : await fs.readFile(path));
          uncaptured = isUncaptured?.(path, observed ?? raw) ?? false;
          const data = parseFrontmatter(raw).data;
          validateCardHeader(id, data);
          if (options.unfinishedOnly && completedCard(data)) continue;
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
            ...(uncaptured ? { uncaptured: true } : {}),
          };
          items.push(item);
          selected.push(item);
          sourceSets.set(id, Array.isArray(data.sources) ? (data.sources as MaterialSource[]) : []);
          const sources = sourcesSchema.safeParse(data.sources);
          if (!sources.success) sourceErrors.set(id, sources.error.message);
        } catch {
          items.push({
            cardId: id,
            path,
            diagnostic: "Card header unavailable; inspect raw",
            ...(uncaptured ? { uncaptured: true } : {}),
          });
        }
      }
    }),
  );
  if (selected.length && fs.history && (await fs.history.available())) {
    try {
      const times = await fs.history.firstCommitTimes(selected.map((item) => item.path));
      for (const item of selected) {
        const time = times.get(item.path);
        item.publishedAt = time ?? null;
        if (time) item.orderKey = cardOrderKey(String(item.cardId), time);
      }
    } catch {
      for (let i = 0; i < items.length; i++) {
        const { cardId, path, uncaptured } = items[i]!;
        items[i] = {
          cardId,
          path,
          diagnostic: "Card header unavailable; inspect raw",
          ...(uncaptured ? { uncaptured: true } : {}),
        };
      }
    }
  }
  const visible = items.filter((item) => {
    if (item.diagnostic) return true;
    // Without readable history, a header alone is never evidence of publication.
    item.publishedAt ??= null;
    return item.publishedAt !== null;
  });
  if (options.waiting) {
    const lane = (item: Record<string, unknown>) =>
      item.diagnostic ? 3 : item.state === "pending" ? 0 : item.state === "consumed" ? 1 : 2;
    visible.sort((a, b) => {
      const order = lane(a) - lane(b);
      if (order) return order;
      const ak = String(a.orderKey ?? a.cardId),
        bk = String(b.orderKey ?? b.cardId);
      return ak < bk ? -1 : ak > bk ? 1 : 0;
    });
    return { items: visible, sourceSets, sourceErrors };
  }
  visible.sort((a, b) => {
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
  return { items: visible, sourceSets, sourceErrors };
}

export async function listCardDocuments(
  fs: FsAdapter,
  options: Parameters<typeof listCardDocumentHeaders>[1] & { retainedState?: boolean } = {},
  currentHeaders?: Awaited<ReturnType<typeof listCardDocumentHeaders>>,
) {
  const read = async () => {
    const { items: visible } =
      currentHeaders ??
      (await listCardDocumentHeaders(fs, {
        ...options,
        uncaptured: options.retainedState || options.uncaptured,
      }));
    return { revision: canonicalSha256(visible), items: visible };
  };
  return fs.observationScope ? fs.observationScope(read) : read();
}
