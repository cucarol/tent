import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { readOnlyFs, withTentMutation, type FsAdapter } from "./adapter.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { isCardId, isRoleId, makeCardId } from "./id.js";
import {
  CARDS_DIR,
  cardRecordPath,
  roleDocumentPath,
  MUTATION_LOCK_PATH,
  nodeNotePath,
} from "./paths.js";
import { contentEtag } from "./etag.js";
import { documentLifecycle } from "./document-status.js";
import { documentVersionSchema, type DocumentVersion } from "./git-history.js";
import {
  materialLocator,
  isDirectoryMaterial,
  sourcesSchema,
  type MaterialSource,
} from "./material.js";
import { isHistoryDocument } from "./document-history.js";
import { parseRoleDocument } from "./role-document.js";
import { boundary, ReaderError, type ReaderRange } from "./context-reader.js";
import { canonicalSha256 } from "./canonical-digest.js";
import { canonicalDocumentReferences } from "./document-links.js";
import {
  documentHeader,
  loadNodeCatalog,
  readCatalogDocument,
  type NodeCatalog,
} from "./node-catalog.js";
import { listWorkspaceRelations, type DocumentRef } from "./workspace-relations.js";
import { cardSourceIdentityError, readCardProgress } from "./card-progress.js";

export type CardDocumentState = "pending" | "consumed";
type CardFields = Record<string, unknown> & {
  type: "card";
  id: string;
  schemaVersion: 3;
  sources: MaterialSource[];
  title?: string;
  target?: string;
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
  if (data.type !== "card" || data.id !== id || data.schemaVersion !== 3)
    invalid("Expected a Card v3 document with matching id");
  if (data.title !== undefined && (typeof data.title !== "string" || !data.title.trim()))
    invalid("Card title must be nonempty text");
  if (data.target !== undefined && (typeof data.target !== "string" || !isRoleId(data.target)))
    invalid("Card target must be an explicit Role id");
  if (!["pending", "consumed"].includes(String(data.state))) invalid("Invalid Card state");
  if (
    data.receivedBy !== undefined &&
    (data.state === "pending" || typeof data.receivedBy !== "string" || !isRoleId(data.receivedBy))
  )
    invalid("Card state and receivedBy disagree");
  if (data.state !== "pending" && data.target !== undefined && data.receivedBy !== data.target)
    invalid("Targeted Card must be received with its Role");
  return {
    path,
    raw,
    etag: contentEtag(raw),
    body: parsed.body,
    data: data as CardFields,
    keyOrder: parsed.keyOrder,
  };
}
function inputOf(document: CardDocument) {
  const { state, receivedBy, status, target, ...fields } = document.data;
  return { fields, body: document.body };
}
function stateOf(document: CardDocument) {
  return {
    state: document.data.state,
    receivedBy: document.data.receivedBy,
    target: document.data.target,
    status: document.data.status,
  };
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
function checkEtag(card: CardDocument, expectedEtag: string) {
  if (!expectedEtag || card.etag !== expectedEtag)
    cardConflict(card, "STATE_CHANGED", "Card bytes changed; reread before saving");
}
async function checkUnchanged(fs: FsAdapter, card: CardDocument) {
  if ((await fs.readFile(card.path)) !== card.raw)
    throw new CardDocumentError(
      "STATE_CHANGED",
      "Card changed during checks; reread before saving",
    );
}
async function liveCard(fs: FsAdapter, id: string) {
  return parseCardDocument(
    id,
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      await fs.readBinary(cardPath(id)),
    ),
  );
}
async function historyOf(fs: FsAdapter) {
  if (!fs.history || !(await fs.history.available()))
    throw new CardDocumentError(
      "UNPUBLISHED",
      "Card operations require independent Tent Git history",
    );
  return fs.history;
}
async function roleAvailable(fs: FsAdapter, roleId: string) {
  try {
    if (!isRoleId(roleId)) throw new Error("Invalid Role id");
    const path = roleDocumentPath(roleId);
    const role = parseRoleDocument(
      roleId,
      fs.readFrontmatter ? await fs.readFrontmatter(path) : await fs.readFile(path),
    );
    const status = documentLifecycle(parseFrontmatter(role.raw).data).status;
    if (status !== "stable" && status !== "draft") throw new Error("Role is not current");
  } catch (error) {
    throw new CardDocumentError(
      "ROLE_UNAVAILABLE",
      `Role unavailable: ${roleId}: ${String(error)}`,
    );
  }
}

function sourceVersion(owner: string, source: MaterialSource) {
  const version = documentVersionSchema.parse(source.version),
    locator = materialLocator(source.resource, owner, true);
  if (
    locator.kind !== "path" ||
    isDirectoryMaterial(locator) ||
    locator.target !== version.path ||
    version.path === ".." ||
    version.path.startsWith("../") ||
    version.path.startsWith(CARDS_DIR + "/") ||
    !isHistoryDocument(version.path)
  )
    invalid("A source Git version must address its selected Tent Node or Role");
  return version;
}

/** Validate a retained source without consulting or capturing its live document. */
export async function verifyCardSourceVersion(
  fs: FsAdapter,
  owner: string,
  source: MaterialSource,
) {
  const version = sourceVersion(owner, source);
  const history = await historyOf(fs);
  const changedSince = await history.changedSince(version);
  const raw = await history.read(version);
  validateSource(version.path, raw);
  return { version, raw, changedSince };
}

/** A query-scoped batch, with the same address and identity checks as single-source reads. */
export async function verifyCardSourceVersions(
  fs: FsAdapter,
  sources: ReadonlyArray<{ owner: string; source: MaterialSource }>,
) {
  const selected = sources.map(({ owner, source }) => {
    try {
      return sourceVersion(owner, source);
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  });
  const versions = selected.filter((value): value is DocumentVersion => !(value instanceof Error));
  let retained: Awaited<ReturnType<NonNullable<FsAdapter["history"]>["readVersions"]>> = [];
  if (versions.length) {
    try {
      if (!fs.history)
        throw new CardDocumentError(
          "UNPUBLISHED",
          "Card operations require independent Tent Git history",
        );
      retained = await fs.history.readVersions(versions);
    } catch (error) {
      retained = versions.map(() => (error instanceof Error ? error : new Error(String(error))));
    }
  }
  let index = 0;
  return selected.map((version) => {
    if (version instanceof Error) return version;
    const value = retained[index++]!;
    if (value instanceof Error) return value;
    try {
      validateSource(value.version.path, value.raw, value.frontmatter);
      return value;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  });
}

/** Only the selected Node/Role bytes are captured. External declarations remain addresses. */
async function captureSources(fs: FsAdapter, owner: string, sources: MaterialSource[]) {
  const history = await historyOf(fs),
    selected: Array<{ path: string; raw: string }> = [];
  const paths = new Map<number, string>();
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i]!,
      locator = materialLocator(source.resource, owner, true);
    const file =
      locator.kind === "path" && !isDirectoryMaterial(locator) ? locator.target : undefined;
    const internal =
      file &&
      file !== ".." &&
      !file.startsWith("../") &&
      !file.startsWith(CARDS_DIR + "/") &&
      isHistoryDocument(file);
    if (source.version !== undefined) {
      await verifyCardSourceVersion(fs, owner, source);
    } else if (internal) {
      if (fs.invalidNodeEdits?.has(file))
        invalid(`Invalid Node source: ${file}: ${fs.invalidNodeEdits.get(file)}`);
      const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        await fs.readBinary(file),
      );
      validateSource(file, raw);
      paths.set(i, file);
      if (!selected.some((item) => item.path === file)) selected.push({ path: file, raw });
    }
  }
  const versions = selected.length
    ? (await history.captureUnlocked(selected, { operation: "document.external-capture" })).versions
    : [];
  return sources.map((source, i) =>
    paths.has(i) ? { ...source, version: versions.find((v) => v.path === paths.get(i))! } : source,
  );
}
function validateSource(file: string, raw: string, data = parseFrontmatter(raw).data) {
  const error = cardSourceIdentityError(file, raw, data);
  if (error) invalid(error);
}

async function checkedCard(fs: FsAdapter, id: string, reception?: { roleId?: string }) {
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
  const recovery =
    reception !== undefined &&
    latest.data.state === "pending" &&
    current.data.state === "consumed" &&
    current.data.receivedBy === reception.roleId &&
    isDeepStrictEqual(stateOf(current), {
      ...stateOf(latest),
      state: "consumed",
      receivedBy: reception.roleId,
    });
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
      const sources = input.sources ?? [];
      sourcesSchema.parse(sources);
      const fields = {
        type: "card",
        id,
        schemaVersion: 3,
        sources,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.target !== undefined ? { target: input.target } : {}),
        state: "pending",
      };
      const prompt = await canonicalDocumentReferences(fs, path, fields, input.prompt);
      const card = parseCardDocument(id, serializeFrontmatter(fields, prompt));
      requireInput(card);
      if (card.data.target) await roleAvailable(fs, card.data.target);
      card.data.sources = await captureSources(fs, path, card.data.sources);
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
        ...(
          await readCardProgress(fs, [{ cardId: id, state: "pending", sources: card.data.sources }])
        ).get(id)!,
        etag: contentEtag(raw),
        version: captured.versions[0]!,
      };
    },
    { operation: "card.create" },
  );
}

/** Published Cards can change destination only before reception. */
export function moveCardDocument(
  fs: FsAdapter,
  id: string,
  input: { target: string | null; expectedEtag: string },
) {
  return withTentMutation(
    fs,
    async () => {
      const { current, history, version } = await checkedCard(fs, id);
      if (current.data.state !== "pending")
        cardConflict(current, "RECEPTION_CONFLICT", "Card has already been received");
      checkEtag(current, input.expectedEtag);
      if (input.target !== null) await roleAvailable(fs, input.target);
      const fields = { ...current.data };
      if (input.target === null) delete fields.target;
      else fields.target = input.target;
      const raw =
        current.data.target === fields.target
          ? current.raw
          : serializeFrontmatter(fields, current.body, current.keyOrder);
      await checkUnchanged(fs, current);
      if (raw === current.raw)
        return {
          cardId: id,
          path: current.path,
          etag: current.etag,
          state: current.data.state,
          target: input.target,
          version,
        };
      await fs.writeFile(current.path, raw);
      const captured = await history.captureUnlocked([{ path: current.path, raw }], {
        operation: "card.move",
      });
      return {
        cardId: id,
        path: current.path,
        etag: contentEtag(raw),
        state: current.data.state,
        target: input.target,
        version: captured.versions[0]!,
      };
    },
    { operation: "card.move" },
  );
}

/** Cancel a published task without altering its recorded input or reception. */
export function deprecateCardDocument(fs: FsAdapter, id: string, expectedEtag: string) {
  return withTentMutation(
    fs,
    async () => {
      const { current, history, version } = await checkedCard(fs, id);
      checkEtag(current, expectedEtag);
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

async function deprecatedCardNotice(fs: FsAdapter, card: CardDocument) {
  if (documentLifecycle(card.data).status !== "deprecated") return {};
  const notice =
    "This Card is deprecated; its task was cancelled. Review current references before acting.";
  try {
    const catalog = await loadNodeCatalog(fs);
    const references = new Map<string, DocumentRef & { path: string }>();
    const relations = await listWorkspaceRelations(fs);
    const published = new Set(
      (await listCardDocuments(fs, { includeDeprecated: true })).items
        .filter((item) => !item.diagnostic)
        .map((item) => item.cardId),
    );
    for (const relation of relations) {
      if (relation.target.kind !== "card" || relation.target.id !== card.data.id) continue;
      const { from } = relation;
      if (from.kind === "card" && !published.has(from.id)) continue;
      const path =
        from.kind === "node"
          ? nodeNotePath(catalog.byId.get(from.id)!.path)
          : from.kind === "role"
            ? roleDocumentPath(from.id)
            : cardPath(from.id);
      const data = parseFrontmatter(await fs.readFile(path)).data;
      const status = documentLifecycle(data).status;
      if (status !== "stable" && status !== "draft") continue;
      references.set(`${from.kind}:${from.id}`, { ...from, path });
    }
    return { notice, currentReferences: [...references.values()] };
  } catch (error) {
    return {
      notice,
      currentReferencesDiagnostic: error instanceof Error ? error.message : String(error),
    };
  }
}

type PageOptions = {
  view?: "body" | "raw";
  range?: ReaderRange;
  expectedEtag?: string;
  capture?: boolean;
  /** Internal callers already holding batch progress can skip a second derivation. */
  includeProgress?: boolean;
};
function cardPage(
  id: string,
  raw: string,
  options: PageOptions,
  metadata: Record<string, unknown>,
) {
  const path = cardPath(id),
    etag = contentEtag(raw),
    view = options.view ?? "body";
  let text = raw;
  if (view === "body") {
    try {
      text = parseFrontmatter(raw).body;
    } catch {
      invalid("Malformed Card YAML; read raw to inspect its original bytes");
    }
  }
  const range = options.range ?? { unit: "utf16" as const, start: 0, end: text.length };
  if (
    range.unit !== "utf16" ||
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start < 0 ||
    range.end < range.start ||
    range.end > text.length ||
    boundary(text, range.start) !== range.start ||
    boundary(text, range.end) !== range.end
  )
    throw new ReaderError("INVALID_RANGE", "Card range must preserve UTF-16 and CRLF boundaries");
  if (options.expectedEtag && options.expectedEtag !== etag)
    throw new ReaderError("SOURCE_CHANGED", "Card changed; reread before continuing");
  return {
    cardId: id,
    path,
    etag,
    view,
    ...metadata,
    text: text.slice(range.start, range.end),
    range,
    total: text.length,
  };
}

/** Invalid manual edits remain raw-readable but never become fresh acceptance evidence. */
export async function readCardDocument(fs: FsAdapter, id: string, options: PageOptions = {}) {
  const read = async () => {
    const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      await fs.readBinary(cardPath(id)),
    );
    let checked: Awaited<ReturnType<typeof checkedCard>>;
    try {
      checked = await checkedCard(fs, id);
    } catch (error) {
      if (!(error instanceof CardDocumentError)) throw error;
      const metadata: Record<string, unknown> = {
        diagnostic: { code: error.code, message: error.message.slice(0, 512) },
      };
      return cardPage(id, raw, options, metadata);
    }
    if (checked.current.raw !== raw)
      throw new ReaderError("SOURCE_CHANGED", "Card changed during lookup");
    const { current, history, publishedVersion } = checked;
    const metadata = {
      publishedVersion,
      sources: current.data.sources,
      title: current.data.title,
      target: current.data.target,
      state: current.data.state,
      receivedBy: current.data.receivedBy,
      ...(options.includeProgress === false
        ? {}
        : (
            await readCardProgress(fs, [
              { cardId: id, state: current.data.state, sources: current.data.sources },
            ])
          ).get(id)!),
      ...documentLifecycle(current.data),
      ...(await deprecatedCardNotice(fs, current)),
    };
    const page = cardPage(id, raw, options, metadata);
    if (!options.capture) return { ...page, version: checked.version };
    const captured = await history.captureUnlocked([{ path: current.path, raw }], {
      operation: "document.external-capture",
    });
    return { ...page, version: captured.versions[0] };
  };
  return options.capture && fs.withLock ? fs.withLock(MUTATION_LOCK_PATH, read) : read();
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
        roleId,
      });
      if (roleId !== undefined) await roleAvailable(fs, roleId);
      const status = documentLifecycle(current.data).status;
      if (status !== "stable" && status !== "draft" && status !== "deprecated")
        throw new CardDocumentError("RECEPTION_CONFLICT", "Card is not current");
      if (current.data.target && roleId === undefined)
        throw new CardDocumentError(
          "RECEPTION_CONFLICT",
          `Card ${id} is addressed to ${current.data.target}; you took it as no Role.`,
        );
      if (current.data.target && current.data.target !== roleId)
        throw new CardDocumentError(
          "RECEPTION_CONFLICT",
          `Card ${id} is addressed to ${current.data.target}; you took it as ${roleId}.`,
        );
      if (current.data.state !== "pending" && current.data.receivedBy !== roleId)
        throw new CardDocumentError(
          "RECEPTION_CONFLICT",
          "Card reception uses a different Role context",
        );
      const state = current.data.state;
      const nextState = "consumed";
      const replayed = state === "consumed" && !recovery;
      const raw =
        state === nextState
          ? current.raw
          : serializeFrontmatter(
              {
                ...current.data,
                state: nextState,
                ...(roleId !== undefined ? { receivedBy: roleId } : {}),
              },
              current.body,
              current.keyOrder,
            );
      const metadata = {
        publishedVersion,
        sources: current.data.sources,
        title: current.data.title,
        target: current.data.target,
        state: nextState,
        receivedBy: roleId,
        replayed,
        ...(
          await readCardProgress(fs, [
            { cardId: id, state: "consumed", sources: current.data.sources },
          ])
        ).get(id)!,
        ...documentLifecycle(current.data),
        ...(await deprecatedCardNotice(fs, current)),
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
      return cardPage(id, raw, {}, { ...metadata, version: savedVersion });
    },
    { operation: "card.take" },
  );
}

/** Wait for published pending input; idle polls read only the independent Git HEAD. */
export async function watchCardDocuments(
  fs: FsAdapter,
  roleId: string,
  timeoutSeconds?: number,
): Promise<Array<{ cardId: string; title?: string }>> {
  if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0))
    throw new Error("--timeout must be a nonnegative number of seconds");
  await roleAvailable(fs, roleId);
  const history = await historyOf(fs);
  const deadline =
    performance.now() + (timeoutSeconds === undefined ? Infinity : timeoutSeconds * 1000);
  let observed: string | null | undefined;
  for (;;) {
    const head = await history.currentCommit();
    if (head !== observed) {
      observed = head;
      await roleAvailable(fs, roleId);
      const items: Array<{ cardId: string; title?: string }> = [];
      for (const [path, raw] of head ? await history.readDirectory(head, CARDS_DIR) : []) {
        const name = path.slice(CARDS_DIR.length + 1);
        const id = name.slice(0, -3);
        if (!name.endsWith(".md") || !isCardId(id)) continue;
        const card = parseCardDocument(id, raw);
        if (
          card.data.state === "pending" &&
          card.data.target === roleId &&
          documentLifecycle(card.data).status !== "deprecated"
        )
          items.push({ cardId: id, ...(card.data.title ? { title: card.data.title } : {}) });
      }
      if (items.length) return items;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) return [];
    await delay(Math.min(3000, remaining));
  }
}

export async function listCardDocumentHeaders(
  fs: FsAdapter,
  options: {
    cardIds?: readonly string[];
    roleId?: string;
    includeOpen?: boolean;
    state?: CardDocumentState;
    includeDeprecated?: boolean;
  } = {},
) {
  if (options.roleId) await roleAvailable(fs, options.roleId);
  const cardIds = options.cardIds ? new Set(options.cardIds) : undefined;
  const items: Array<Record<string, unknown>> = [];
  const selected: Array<Record<string, unknown> & { path: string }> = [];
  const sourceSets = new Map<string, MaterialSource[]>();
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
        if (cardIds && !cardIds.has(id)) continue;
        const path = cardPath(id);
        try {
          const raw = fs.readFrontmatter ? await fs.readFrontmatter(path) : await fs.readFile(path),
            data = parseFrontmatter(raw).data;
          if (data.id !== id || data.type !== "card" || data.schemaVersion !== 3)
            invalid("Card header identity mismatch");
          const state = data.state;
          if (state !== "pending" && state !== "consumed") invalid("Invalid Card state");
          if (!options.includeDeprecated && documentLifecycle(data).status === "deprecated")
            continue;
          if (options.state && state !== options.state) continue;
          if (
            options.roleId &&
            (state === "pending"
              ? data.target !== options.roleId &&
                !(options.includeOpen && data.target === undefined)
              : data.receivedBy !== options.roleId)
          )
            continue;
          const item = {
            cardId: id,
            path,
            title: data.title,
            state,
            target: data.target,
            receivedBy: data.receivedBy,
            ...documentLifecycle(data),
          };
          items.push(item);
          selected.push(item);
          sourceSets.set(id, Array.isArray(data.sources) ? (data.sources as MaterialSource[]) : []);
        } catch {
          items.push({ cardId: id, path, diagnostic: "Card header unavailable; inspect raw" });
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
      }
    } catch {
      for (let i = 0; i < items.length; i++) {
        const { cardId, path } = items[i]!;
        items[i] = { cardId, path, diagnostic: "Card header unavailable; inspect raw" };
      }
    }
  }
  const visible = items.filter((item) => {
    if (item.diagnostic) return true;
    // Without readable history, a header alone is never evidence of publication.
    item.publishedAt ??= null;
    return item.publishedAt !== null;
  });
  visible.sort((a, b) => {
    const aTime = String(a.publishedAt ?? ""),
      bTime = String(b.publishedAt ?? "");
    if (aTime !== bTime) return aTime > bTime ? -1 : 1;
    const aId = String(a.cardId),
      bId = String(b.cardId);
    return aId < bId ? -1 : aId > bId ? 1 : 0;
  });
  return { items: visible, sourceSets };
}

export async function listCardDocuments(
  fs: FsAdapter,
  options: Parameters<typeof listCardDocumentHeaders>[1] = {},
  currentInspections?: Promise<readonly import("./node-sync.js").NodeSyncInspection[]>,
  currentCatalog?: NodeCatalog | Promise<NodeCatalog | undefined>,
  currentHeaders?: Awaited<ReturnType<typeof listCardDocumentHeaders>>,
) {
  const { items: visible, sourceSets } =
    currentHeaders ?? (await listCardDocumentHeaders(fs, options));
  if (visible.some((item) => !item.diagnostic)) {
    const progress = await readCardProgress(
      fs,
      visible
        .filter((item) => !item.diagnostic)
        .map((item) => ({
          cardId: String(item.cardId),
          state: item.state as CardDocumentState,
          sources: sourceSets.get(String(item.cardId)) ?? [],
        })),
      currentInspections,
      currentCatalog,
    );
    for (const item of visible)
      if (!item.diagnostic) Object.assign(item, progress.get(String(item.cardId)));
  }
  return { revision: canonicalSha256(visible), items: visible };
}

export type ReceivedCardSourceChange = {
  cardId: string;
  title?: string;
  receivedBy?: string;
  nodeId: string;
  resource: string;
  path?: string;
  state: "changed" | "missing";
  publishedVersion: DocumentVersion;
  currentEtag?: string;
  reason: string;
};
export type ReceivedCardSourceDiagnostic = {
  cardId?: string;
  nodeId?: string;
  resource?: string;
  message: string;
};

/** Compare pinned Node bytes with live content. Queries never capture or recover documents. */
export async function inspectReceivedCardSourceChanges(
  fs: FsAdapter,
  options: { roleId?: string } = {},
  listedCards?: Pick<Awaited<ReturnType<typeof listCardDocuments>>, "items">,
  currentCatalog?: NodeCatalog | Promise<NodeCatalog | undefined>,
) {
  const items: ReceivedCardSourceChange[] = [];
  const diagnostics: ReceivedCardSourceDiagnostic[] = [];
  const readonly = readOnlyFs(fs);
  try {
    if (!(await readonly.exists(CARDS_DIR))) return { items, diagnostics };
    const listed =
      listedCards ?? (await listCardDocuments(readonly, { ...options, state: "consumed" }));
    for (const item of listed.items) {
      if (item.diagnostic && item.state !== "pending")
        diagnostics.push({ cardId: String(item.cardId), message: String(item.diagnostic) });
    }
    const candidates = listed.items.filter((item) => !item.diagnostic && item.state === "consumed");
    if (!candidates.length) return { items, diagnostics };
    const live = new Map<string, string | Error>();
    let nextRead = 0;
    const liveReads = Promise.all(
      Array.from({ length: Math.min(16, candidates.length) }, async () => {
        for (;;) {
          const item = candidates[nextRead++];
          if (!item) return;
          const id = String(item.cardId);
          try {
            const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
              await readonly.readBinary(cardPath(id)),
            );
            live.set(id, raw);
          } catch (error) {
            live.set(id, error instanceof Error ? error : new Error(String(error)));
          }
        }
      }),
    );
    const history = await historyOf(readonly);
    // One identity/history scan and two source batches serve the whole query.
    const identities = await history.derived("identity-versions", 1, async () => {
      const first: Record<string, DocumentVersion> = {};
      const latest: Record<string, DocumentVersion> = {};
      for (const commit of await history.changesInRange())
        for (const change of commit.changes) {
          if (!change.objectId) continue;
          if (change.after) {
            first[change.objectId] ??= change.after;
            latest[change.objectId] = change.after;
          } else delete latest[change.objectId];
        }
      return { first, latest };
    });
    const first = new Map(Object.entries(identities.first));
    const latest = new Map(Object.entries(identities.latest));
    const requested = candidates.flatMap((item) => {
      const id = String(item.cardId),
        published = first.get(id),
        current = latest.get(id);
      return published && current ? [published, current] : [];
    });
    const [retained] = await Promise.all([history.readVersions(requested), liveReads]);
    const retainedCard = (id: string, value: Exclude<(typeof retained)[number], Error>) =>
      value.frontmatter
        ? cardFromParsed(id, value.raw, {
            data: value.frontmatter,
            body: value.raw.slice(documentHeader(value.raw).length),
            keyOrder: [],
          })
        : parseCardDocument(id, value.raw);
    type SelectedSource = { card: CardDocument; owner: string; source: MaterialSource };
    const retainedById = new Map<string, typeof retained>();
    let offset = 0;
    for (const item of candidates) {
      const id = String(item.cardId);
      if (first.has(id) && latest.has(id))
        retainedById.set(id, retained.slice(offset, (offset += 2)));
    }
    const validateCard = async (item: Record<string, unknown>) => {
      const id = String(item.cardId),
        selected: SelectedSource[] = [];
      let diagnostic: ReceivedCardSourceDiagnostic | undefined;
      try {
        if (!first.has(id) || !latest.has(id))
          throw new Error("Card publication history is unavailable");
        const versions = retainedById.get(id)!;
        const published = versions[0]!,
          previous = versions[1]!;
        if (published instanceof Error) throw published;
        if (previous instanceof Error) throw previous;
        const raw = live.get(id)!;
        if (raw instanceof Error) throw raw;
        const previousCard = retainedCard(id, previous);
        const current = raw === previous.raw ? previousCard : parseCardDocument(id, raw);
        validateRetainedCard(current, retainedCard(id, published), previousCard);
        if (
          documentLifecycle(current.data).status === "deprecated" ||
          current.data.state === "pending" ||
          (options.roleId && current.data.receivedBy !== options.roleId)
        )
          return { selected };
        for (const source of current.data.sources) {
          if (!source.version) continue;
          const version = sourceVersion(current.path, source);
          if (!version.path.startsWith("roles/"))
            selected.push({ card: current, owner: current.path, source });
        }
      } catch (error) {
        diagnostic = {
          cardId: id,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      return { selected, diagnostic };
    };
    const checked: Awaited<ReturnType<typeof validateCard>>[] = new Array(candidates.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(16, candidates.length) }, async () => {
        for (;;) {
          const index = next++;
          if (index >= candidates.length) return;
          checked[index] = await validateCard(candidates[index]!);
        }
      }),
    );
    const selected = checked.flatMap((entry) => entry.selected);
    for (const entry of checked) if (entry.diagnostic) diagnostics.push(entry.diagnostic);
    if (!selected.length) return { items, diagnostics };
    const sources = await verifyCardSourceVersions(readonly, selected);
    const catalog = (await currentCatalog) ?? (await loadNodeCatalog(readonly));
    const observed = new Map<string, Awaited<ReturnType<typeof readCatalogDocument>> | Error>();
    const liveNodes = [
      ...new Set(
        sources
          .filter((source) => !(source instanceof Error))
          .map((source) => {
            if (source instanceof Error) throw source;
            return String((source.frontmatter ?? parseFrontmatter(source.raw).data).id);
          }),
      ),
    ];
    let nextLive = 0;
    await Promise.all(
      Array.from({ length: Math.min(16, liveNodes.length) }, async () => {
        for (;;) {
          const id = liveNodes[nextLive++];
          if (!id) return;
          const node = catalog.byId.get(id);
          if (!node) continue;
          try {
            observed.set(id, await readCatalogDocument(readonly, node));
          } catch (error) {
            observed.set(id, error instanceof Error ? error : new Error(String(error)));
          }
        }
      }),
    );
    for (const [index, entry] of selected.entries()) {
      const { card, source } = entry;
      let nodeId: string | undefined;
      try {
        const pinned = sources[index]!;
        if (pinned instanceof Error) throw pinned;
        nodeId = String((pinned.frontmatter ?? parseFrontmatter(pinned.raw).data).id);
        const node = catalog.byId.get(nodeId);
        const base = {
          cardId: card.data.id,
          title: card.data.title,
          receivedBy: card.data.receivedBy,
          nodeId,
          resource: source.resource,
          publishedVersion: pinned.version,
        };
        if (!node) {
          if (
            [...catalog.byPath.values()].some(
              (value) =>
                value.nodeId === nodeId ||
                (value.invalid && nodeNotePath(value.path) === pinned.version.path),
            )
          )
            throw new Error("Source Node exists but its identity is invalid or duplicated");
          items.push({
            ...base,
            state: "missing",
            reason: "Source Node is missing from the current workspace",
          });
          continue;
        }
        if (!observed.has(nodeId)) {
          try {
            observed.set(nodeId, await readCatalogDocument(readonly, node));
          } catch (error) {
            observed.set(nodeId, error instanceof Error ? error : new Error(String(error)));
          }
        }
        const current = observed.get(nodeId)!;
        if (current instanceof Error) throw current;
        if (current.raw === pinned.raw) continue;
        items.push({
          ...base,
          path: nodeNotePath(node.path),
          state: "changed",
          currentEtag: current.etag,
          reason:
            "Current Node content differs from the source version retained at Card publication",
        });
      } catch (error) {
        diagnostics.push({
          cardId: card.data.id,
          nodeId,
          resource: source.resource,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    diagnostics.push({ message: error instanceof Error ? error.message : String(error) });
  }
  return { items, diagnostics };
}
