import { isDeepStrictEqual } from "node:util";
import { withTentMutation, type FsAdapter } from "./adapter.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { isCardId, isRoleId, makeCardId } from "./id.js";
import { CARDS_DIR, cardRecordPath, roleDocumentPath, MUTATION_LOCK_PATH } from "./paths.js";
import { contentEtag } from "./etag.js";
import { documentLifecycle } from "./document-status.js";
import { documentVersionSchema, type DocumentVersion } from "./git-history.js";
import { materialLocator, sourcesSchema, type MaterialSource } from "./material.js";
import { isHistoryDocument } from "./document-history.js";
import { parseRoleDocument } from "./role-document.js";
import { boundary, ReaderError, type ReaderRange } from "./context-reader.js";
import { canonicalSha256 } from "./canonical-digest.js";
import { canonicalIdentityError } from "./tree.js";
import { canonicalDocumentReferences } from "./document-links.js";

export type CardDocumentState = "pending" | "consumed" | "interrupted";
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
      | "ALREADY_PUBLISHED"
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
  const path = cardPath(id);
  let parsed: ReturnType<typeof parseFrontmatter>;
  try {
    parsed = parseFrontmatter(raw);
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
  if (!["pending", "consumed", "interrupted"].includes(String(data.state)))
    invalid("Invalid Card state");
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
  };
}
function requireInput(card: CardDocument) {
  if (!card.body.trim() && !card.data.sources.length) invalid("Card needs prompt text or sources");
}
function deletedDraftPath(id: string) {
  return `${CARDS_DIR}/.deleted/${cardPath(id).slice(CARDS_DIR.length + 1, -3)}`;
}
async function requireUnusedId(fs: FsAdapter, id: string) {
  const history = await historyOf(fs);
  if (
    (await fs.exists(cardPath(id))) ||
    (await fs.exists(deletedDraftPath(id))) ||
    (await history.pathVersions(cardPath(id))).first
  )
    invalid("Card id already exists in files or history; create a new identity");
}
function cardConflict(
  card: CardDocument,
  code: "STATE_CHANGED" | "RECEPTION_CONFLICT" | "ALREADY_PUBLISHED",
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
function withCardLock<T>(fs: FsAdapter, action: () => Promise<T>) {
  return fs.withLock ? fs.withLock(MUTATION_LOCK_PATH, action) : action();
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
      validateSource(value.version.path, value.raw);
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
    const file = locator.kind === "path" ? locator.target : undefined;
    const internal =
      file &&
      file !== ".." &&
      !file.startsWith("../") &&
      !file.startsWith(CARDS_DIR + "/") &&
      isHistoryDocument(file);
    if (source.version !== undefined) {
      await verifyCardSourceVersion(fs, owner, source);
    } else if (internal) {
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
function validateSource(file: string, raw: string) {
  const data = parseFrontmatter(raw).data;
  if (file.startsWith("roles/")) {
    try {
      parseRoleDocument(file.slice(6, -3), raw);
    } catch {
      invalid("Selected Role is invalid");
    }
  } else {
    const error = canonicalIdentityError(data);
    if (error) invalid(error);
  }
}

async function checkedCard(fs: FsAdapter, id: string) {
  const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    await fs.readBinary(cardPath(id)),
  );
  const current = parseCardDocument(id, raw),
    history = await historyOf(fs);
  const versions = await history.pathVersions(current.path);
  if (!versions.first || !versions.latest)
    throw new CardDocumentError("UNPUBLISHED", "Handwritten Card requires explicit publish");
  const published = parseCardDocument(id, await history.read(versions.first));
  requireInput(published);
  const latest = parseCardDocument(id, await history.read(versions.latest));
  if (published.data.state !== "pending") invalid("Initial Card publication is not pending");
  if (
    !isDeepStrictEqual(inputOf(current), inputOf(published)) ||
    !isDeepStrictEqual(inputOf(latest), inputOf(published))
  )
    throw new CardDocumentError(
      "INPUT_CHANGED",
      "Published Card input changed; preserve it and create a new Card",
    );
  if (!isDeepStrictEqual(stateOf(current), stateOf(latest)))
    throw new CardDocumentError(
      "STATE_CHANGED",
      "Card management fields differ from retained state; inspect the diff before reconciling",
    );
  return { current, publishedVersion: versions.first, version: versions.latest, history };
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
      const draft = parseCardDocument(id, serializeFrontmatter(fields, prompt));
      requireInput(draft);
      if (draft.data.target) await roleAvailable(fs, draft.data.target);
      draft.data.sources = await captureSources(fs, path, draft.data.sources);
      const raw = serializeFrontmatter(draft.data, draft.body, draft.keyOrder);
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
        etag: contentEtag(raw),
        version: captured.versions[0]!,
      };
    },
    { operation: "card.create" },
  );
}

export type CardDraftInput = {
  prompt: string;
  sources?: MaterialSource[];
  title?: string;
  target?: string | null;
};
async function draftFields(
  fs: FsAdapter,
  id: string,
  input: CardDraftInput,
  previous?: CardDocument,
) {
  if (typeof input.prompt !== "string") invalid("Card prompt must be text");
  const fields = {
    ...previous?.data,
    type: "card",
    id,
    schemaVersion: 3,
    state: "pending",
    sources: input.sources ?? [],
  };
  const data: Record<string, unknown> = fields;
  if (input.title !== undefined) data.title = input.title;
  if (input.target !== undefined && input.target !== null) data.target = input.target;
  else delete data.target;
  const draft = parseCardDocument(id, serializeFrontmatter(data, input.prompt, previous?.keyOrder));
  const body = await canonicalDocumentReferences(fs, draft.path, draft.data, draft.body);
  return parseCardDocument(id, serializeFrontmatter(draft.data, body, draft.keyOrder));
}
function draftResult(id: string, card: CardDocument) {
  return {
    cardId: id,
    path: card.path,
    etag: card.etag,
    draft: true as const,
    state: "pending" as const,
  };
}
async function unpublishedCard(fs: FsAdapter, id: string, expectedEtag: string, deleting = false) {
  const history = await historyOf(fs);
  const card = await liveCard(fs, id);
  if ((await history.pathVersions(card.path)).first)
    cardConflict(card, "ALREADY_PUBLISHED", "Card already has publication history");
  if (!deleting && (await fs.exists(deletedDraftPath(id))))
    invalid("Deleted Card identity cannot be reused");
  checkEtag(card, expectedEtag);
  if (card.data.state !== "pending") invalid("An unpublished Card must be pending");
  return card;
}

/** Draft writes hold the shared lock but deliberately do not capture Card or source history. */
export function createCardDraft(fs: FsAdapter, input: CardDraftInput & { cardId?: string }) {
  return withCardLock(fs, async () => {
    const id = input.cardId ?? makeCardId();
    await requireUnusedId(fs, id);
    const card = await draftFields(fs, id, input);
    if (card.data.target) await roleAvailable(fs, card.data.target);
    await fs.writeFile(card.path, card.raw);
    return draftResult(id, card);
  });
}

export function writeCardDraft(
  fs: FsAdapter,
  id: string,
  input: CardDraftInput & { expectedEtag: string },
) {
  return withCardLock(fs, async () => {
    const before = await unpublishedCard(fs, id, input.expectedEtag);
    const card = await draftFields(fs, id, input, before);
    if (card.data.target) await roleAvailable(fs, card.data.target);
    await checkUnchanged(fs, before);
    if (card.raw !== before.raw) await fs.writeFile(card.path, card.raw);
    return draftResult(id, card);
  });
}

export function deleteCardDraft(fs: FsAdapter, id: string, expectedEtag: string) {
  return withCardLock(fs, async () => {
    const card = await unpublishedCard(fs, id, expectedEtag, true);
    // Reserve the identity before deleting; a failed deletion can be retried with its ETag.
    await fs.writeFile(deletedDraftPath(id), "");
    await checkUnchanged(fs, card);
    await fs.remove(card.path);
    return { cardId: id, path: card.path, deleted: true as const };
  });
}

/** Published Cards can change destination only before reception. Drafts use writeCardDraft. */
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

export function publishCardDocument(fs: FsAdapter, id: string, expectedEtag: string) {
  // Unpublished editor bytes are not a publication preimage. The first retained
  // Card version must contain the final resolved input, not its unversioned draft.
  const publish = async () => {
    const history = await historyOf(fs),
      path = cardPath(id);
    const card = await unpublishedCard(fs, id, expectedEtag),
      raw = card.raw;
    requireInput(card);
    if (card.data.target) await roleAvailable(fs, card.data.target);
    // Publishing is explicit: selected internal source addresses receive actual versions.
    const body = await canonicalDocumentReferences(fs, path, card.data, card.body);
    card.data.sources = await captureSources(fs, path, card.data.sources);
    const after = serializeFrontmatter(card.data, body, card.keyOrder);
    if ((await fs.readFile(path)) !== raw)
      throw new CardDocumentError("STATE_CHANGED", "Card changed while resolving sources");
    if (after !== raw) await fs.writeFile(path, after);
    const captured = await history.captureUnlocked([{ path, raw: after }], {
      operation: "card.publish",
    });
    return {
      cardId: id,
      path,
      etag: contentEtag(after),
      state: "pending" as const,
      version: captured.versions[0]!,
    };
  };
  return withCardLock(fs, publish);
}

type PageOptions = {
  view?: "body" | "raw";
  range?: ReaderRange;
  expectedEtag?: string;
  capture?: boolean;
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
      if (error.code === "UNPUBLISHED") {
        const { sources, title, target, state } = parseCardDocument(id, raw).data;
        Object.assign(metadata, { sources, title, target, state, draft: true });
      }
      return cardPage(id, raw, options, metadata);
    }
    if (checked.current.raw !== raw)
      throw new ReaderError("SOURCE_CHANGED", "Card changed during lookup");
    const { current, history, publishedVersion } = checked;
    const metadata = {
      draft: false,
      publishedVersion,
      sources: current.data.sources,
      title: current.data.title,
      target: current.data.target,
      state: current.data.state,
      receivedBy: current.data.receivedBy,
      ...documentLifecycle(current.data),
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

export function transitionCardDocument(
  fs: FsAdapter,
  id: string,
  roleId: string | undefined,
  action: "take" | "interrupt" | "continue",
  expectedVersion?: DocumentVersion,
) {
  return withTentMutation(
    fs,
    async () => {
      const { current, history, version, publishedVersion } = await checkedCard(fs, id);
      if (roleId !== undefined) await roleAvailable(fs, roleId);
      const status = documentLifecycle(current.data).status;
      if (status !== "stable" && status !== "draft")
        throw new CardDocumentError("RECEPTION_CONFLICT", "Card is not current");
      if (current.data.target && roleId === undefined)
        throw new CardDocumentError(
          "RECEPTION_CONFLICT",
          `Card is addressed to ${current.data.target}; supply --role ${current.data.target}`,
        );
      if (current.data.target && current.data.target !== roleId)
        throw new CardDocumentError("RECEPTION_CONFLICT", "Card is addressed to another Role");
      if (current.data.state !== "pending" && current.data.receivedBy !== roleId)
        throw new CardDocumentError(
          "RECEPTION_CONFLICT",
          "Card reception uses a different Role context",
        );
      if (action !== "take") {
        const expected = expectedVersion && documentVersionSchema.parse(expectedVersion);
        if (
          !expected ||
          expected.path !== current.path ||
          (await history.changedSince(expected)) ||
          (await history.read(expected)) !== (await history.read(version))
        )
          throw new CardDocumentError(
            "STATE_CHANGED",
            "Card retained version changed; inspect before changing its state",
          );
      }
      const state = current.data.state;
      if (action === "take" && state === "interrupted")
        throw new CardDocumentError(
          "RECEPTION_CONFLICT",
          "Interrupted Card requires explicit continue",
        );
      if (action !== "take" && state === "pending")
        throw new CardDocumentError(
          "RECEPTION_CONFLICT",
          "Receive the Card before continuing or interrupting it",
        );
      const nextState = action === "interrupt" ? "interrupted" : "consumed";
      const replayed = action === "take" && state === "consumed";
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
        automaticInterrupt: "unavailable",
      };
      // Qualification/history reads above can yield to an external editor. Do not let
      // the filesystem writer adopt those newer bytes as the basis for this decision.
      if ((await fs.readFile(current.path)) !== current.raw)
        throw new CardDocumentError(
          "STATE_CHANGED",
          "Card changed during reception checks; reread before continuing",
        );
      if (raw !== current.raw) await fs.writeFile(current.path, raw);
      const saved = await history.captureUnlocked([{ path: current.path, raw }], {
        operation: `card.${action}`,
      });
      return cardPage(id, raw, {}, { ...metadata, version: saved.versions[0] });
    },
    { operation: `card.${action}` },
  );
}

export async function listCardDocuments(
  fs: FsAdapter,
  options: {
    roleId?: string;
    includeOpen?: boolean;
    state?: CardDocumentState;
    includeDrafts?: boolean;
  } = {},
) {
  if (options.roleId) await roleAvailable(fs, options.roleId);
  const items: Array<Record<string, unknown>> = [];
  const selected: Array<Record<string, unknown> & { path: string }> = [];
  for (const entry of (await fs.exists(CARDS_DIR))
    ? (await fs.listDir(CARDS_DIR)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    : []) {
    const id = entry.name.slice(0, -3);
    if (entry.isDir || !entry.name.endsWith(".md") || !isCardId(id)) continue;
    const path = cardPath(id);
    try {
      const raw = fs.readFrontmatter ? await fs.readFrontmatter(path) : await fs.readFile(path),
        data = parseFrontmatter(raw).data;
      if (data.id !== id || data.type !== "card" || data.schemaVersion !== 3)
        invalid("Card header identity mismatch");
      const state = data.state;
      if (options.state && state !== options.state) continue;
      if (
        options.roleId &&
        (state === "pending"
          ? data.target !== options.roleId && !(options.includeOpen && data.target === undefined)
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
    } catch {
      items.push({ cardId: id, path, diagnostic: "Card header unavailable; inspect raw" });
    }
  }
  if (selected.length && fs.history && (await fs.history.available())) {
    try {
      const times = await fs.history.firstCommitTimes(selected.map((item) => item.path));
      for (const item of selected) {
        const time = times.get(item.path);
        item.publishedAt = time ?? null;
        item.draft = !time;
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
    item.draft ??= true;
    item.publishedAt ??= null;
    return !item.draft || (options.includeDrafts && !options.state);
  });
  return { revision: canonicalSha256(visible), items: visible };
}
