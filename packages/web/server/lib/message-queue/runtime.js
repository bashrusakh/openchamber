// Server-owned message queue: messages the user queued while a session was
// busy, delivered by the web server the moment the session goes idle. The
// queue lives here, not in the browser, so closing the tab, locking the phone,
// or losing the connection no longer strands what was queued. Structural
// template: permission-auto-accept (server-authoritative state, UI as a
// projection, VS Code keeps its own foreground implementation).
//
// Event-driven like session-goal: the shared upstream hub delivers
// `session.status`, and an idle transition arms a short per-session timer. The
// tick re-verifies idleness against OpenCode (status map + message tail) before
// it sends, because a queued prompt sent into a running turn would be steered
// into it instead of starting the next one.

import fs from 'fs';
import path from 'path';

const QUEUE_FILE_NAME = 'message-queue.json';
const QUEUE_FILE_VERSION = 1;

const MAX_SESSIONS = 50;
const MAX_ITEMS_PER_SESSION = 20;
const CONTENT_CHAR_LIMIT = 200_000;
// A consult item carries its own model-facing payload: the standing system
// prompt and the metadata attached to the primary text part. Both are bounded
// so one queued consult cannot balloon the queue file or the prompt body.
const CONSULT_SYSTEM_CHAR_LIMIT = 24_000;
const CONSULT_TEXT_PART_METADATA_CHAR_LIMIT = 8_000;

// Only a text part can carry part metadata (OpenCode's file parts have no
// metadata field), so an attachment-only consult prompt gets one synthetic
// text part as the receipt carrier. The text becomes part of the
// model-visible transcript: keep it minimal, neutral, and honest.
// Mirrored in the UI's sendMessage (packages/ui/src/lib/opencode/client.ts).
export const CONSULT_RECEIPT_CARRIER_TEXT = '[consult receipt]';

// Idle events arrive in bursts around a turn boundary; a short quiet window
// coalesces them before the tick verifies idleness against OpenCode.
const DISPATCH_QUIET_MS = 500;
// After a user abort the UI held the queue for two seconds so the stop is not
// immediately followed by the next prompt; the server keeps that window.
const ABORT_HOLD_MS = 2_000;
const RETRY_BASE_DELAY_MS = 2_000;
const RETRY_MAX_DELAY_MS = 60_000;
// A hold is asserted by a UI-driven process (auto-review) that dies with the
// UI; it expires unless the UI keeps re-asserting it.
const HOLD_DEFAULT_TTL_MS = 5 * 60 * 1000;
const HOLD_MAX_TTL_MS = 10 * 60 * 1000;
// Independent holders (UI processes, one per feature or run) each own a slot.
// The cap bounds a session's owner map when holds are asserted on sessions
// that never dispatch, which would otherwise only leave on expiry.
const MAX_HOLD_OWNERS_PER_SESSION = 8;
const FETCH_TIMEOUT_MS = 15_000;
const MESSAGE_TAIL_LIMIT = 2;

const ATTACHMENT_SOURCES = new Set(['local', 'server', 'vscode']);
// Context captured with a queued message (see QueuedContextPart in the UI
// store): attached context items carry metadata the timeline renders back;
// the other kinds are plain synthetic text.
const CONTEXT_PART_KINDS = new Set(['context', 'instruction', 'synthetic']);
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;

const getQueuedSendRetryDelayMs = (failures) =>
  Math.min(RETRY_BASE_DELAY_MS * 2 ** Math.max(failures - 1, 0), RETRY_MAX_DELAY_MS);

// Boundary readers: the only place raw JSON (client bodies, the queue file,
// OpenCode responses, hub events) is inspected. Everything below them
// branches on the domain values they return.
const asNonEmptyString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');
const asText = (value) => (typeof value === 'string' ? value : '');
const asRecord = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);
const asList = (value) => (Array.isArray(value) ? value : null);
const asCount = (value) => (Number.isFinite(value) && value >= 0 ? Math.floor(value) : null);

const isValidSessionId = (value) => SESSION_ID_PATTERN.test(asNonEmptyString(value));

const httpError = (message, status) => Object.assign(new Error(message), { status });

const parseSendConfig = (value) => {
  const raw = asRecord(value);
  if (!raw) return null;
  const providerID = asNonEmptyString(raw.providerID);
  const modelID = asNonEmptyString(raw.modelID);
  if (!providerID || !modelID) return null;
  const sendConfig = { providerID, modelID };
  const agent = asNonEmptyString(raw.agent);
  if (agent) sendConfig.agent = agent;
  const variant = asNonEmptyString(raw.variant);
  if (variant) sendConfig.variant = variant;
  return sendConfig;
};

const parseAttachment = (value) => {
  const raw = asRecord(value);
  if (!raw) return null;
  const filename = asNonEmptyString(raw.filename);
  const mimeType = asNonEmptyString(raw.mimeType);
  const dataUrl = asText(raw.dataUrl);
  if (!filename || !mimeType || !dataUrl) return null;
  const attachment = {
    id: asNonEmptyString(raw.id) || `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    filename,
    mimeType,
    size: asCount(raw.size) ?? 0,
    source: ATTACHMENT_SOURCES.has(raw.source) ? raw.source : 'local',
  };
  const serverPath = asNonEmptyString(raw.serverPath);
  if (serverPath) attachment.serverPath = serverPath;
  attachment.dataUrl = dataUrl;
  return attachment;
};

const parseContextPart = (value) => {
  const raw = asRecord(value);
  if (!raw || !CONTEXT_PART_KINDS.has(raw.kind)) return null;
  const text = asText(raw.text);
  if (raw.kind !== 'context') return { kind: raw.kind, text };
  // The metadata is the UI's structured payload; the server only carries it
  // to the prompt, so its shape is the UI's to validate on the way back.
  const metadata = asRecord(raw.metadata);
  if (!metadata) return null;
  const part = { kind: 'context', text, metadata };
  const instructions = asNonEmptyString(raw.instructions);
  if (instructions) part.instructions = instructions;
  return part;
};

// A consult item is enqueued by a consult flow and dispatched only through its
// own claim → payload → dispatch-consult route; the generic dispatcher skips it.
const CONSULT_ITEM_KIND = 'consult';

// Bump whenever the consult queue protocol changes. The UI capability gate
// reads this through GET /api/opencode/version and must fail closed when the
// value is absent or lower than the version it requires.
export const CONSULT_PROTOCOL_VERSION = 1;

// Parses the optional consult payload: { system?, textPartMetadata? }. `system`
// is a plain string; `textPartMetadata` is carried as JSON text (it must be
// serializable and bounded) so the stored item round-trips like every other
// persisted field.
const parseConsultPayload = (value) => {
  const raw = asRecord(value);
  if (!raw) throw new TypeError('invalid consult payload');
  const consult = {};
  if (raw.system !== undefined) {
    // asText is the boundary read: anything that does not survive it verbatim
    // (an empty value, a non-string) is a contract violation, not a default.
    const system = asText(raw.system);
    if (system !== raw.system || !system) throw new TypeError('consult.system must be a string');
    if (system.length > CONSULT_SYSTEM_CHAR_LIMIT) throw new TypeError('consult payload too large');
    consult.system = system;
  }
  if (raw.textPartMetadata !== undefined) {
    let textPartMetadata;
    try {
      textPartMetadata = JSON.stringify(raw.textPartMetadata);
    } catch {
      throw new TypeError('consult.textPartMetadata must be JSON-serializable');
    }
    if (textPartMetadata.length > CONSULT_TEXT_PART_METADATA_CHAR_LIMIT) throw new TypeError('consult payload too large');
    consult.textPartMetadata = raw.textPartMetadata;
  }
  return consult;
};

/**
 * Validates a queued item posted by a client. Throws a TypeError (→ 400) for
 * anything that could not be delivered later: a queue must never hold an item
 * the server cannot send.
 */
export const parseQueuedItemInput = (value) => {
  const raw = asRecord(value);
  if (!raw) throw new TypeError('item is required');
  const content = asText(raw.content).replace(/^\n+|\n+$/g, '');
  if (content.length > CONTENT_CHAR_LIMIT) throw new TypeError('item content is too long');
  const text = raw.text === undefined ? content : asText(raw.text);
  const attachments = (asList(raw.attachments) ?? []).map(parseAttachment);
  if (attachments.some((attachment) => attachment === null)) throw new TypeError('invalid attachment');
  const context = (asList(raw.context) ?? []).map(parseContextPart);
  if (context.some((part) => part === null)) throw new TypeError('invalid context part');
  if (!text.trim() && attachments.length === 0 && context.length === 0) {
    throw new TypeError('item needs text, attachments, or context');
  }
  const sendConfig = parseSendConfig(raw.sendConfig);
  if (!sendConfig) throw new TypeError('item sendConfig with providerID and modelID is required');
  const item = { content, text };
  const agentMention = asNonEmptyString(raw.agentMention);
  if (agentMention) item.agentMention = agentMention;
  item.attachments = attachments;
  item.context = context;
  const contextPreview = asNonEmptyString(raw.contextPreview).slice(0, 103);
  if (contextPreview) item.contextPreview = contextPreview;
  item.sendConfig = sendConfig;
  if (raw.kind !== undefined) {
    if (raw.kind !== CONSULT_ITEM_KIND) throw new TypeError('kind must be "consult"');
    item.kind = raw.kind;
  }
  if (raw.consult !== undefined) item.consult = parseConsultPayload(raw.consult);
  return item;
};

const parseStoredItem = (value) => {
  const raw = asRecord(value);
  const id = raw ? asNonEmptyString(raw.id) : '';
  if (!id) return null;
  try {
    return { id, createdAt: asCount(raw.createdAt) ?? Date.now(), ...parseQueuedItemInput(raw) };
  } catch {
    return null;
  }
};

/** Only consult items carry the recoverable marker; normal items never do. */
const isConsultItem = (item) => item.kind === CONSULT_ITEM_KIND;

/**
 * Drops the stale synthesis from a consult payload while keeping its delivery
 * identity. `consult.system` is regenerated by the next run and must never be
 * re-sent stale; `consult.textPartMetadata` is the acting run's
 * delivery-correlation key — the only way a later Resume can re-check whether
 * the turn already landed before it re-fans-out (the client re-checks delivery
 * before resuming). The payload stays size-bounded: the metadata was capped
 * when it was parsed.
 */
const dropStaleConsultSynthesis = (item) => {
  if (!item.consult) return;
  delete item.consult.system;
  if (Object.keys(item.consult).length === 0) delete item.consult;
};

const toPublicAttachment = ({ dataUrl: _dataUrl, ...attachment }) => attachment;

// What clients see: everything except the payloads — attachment data URLs
// (megabytes of base64) and captured context (a PR diff, say) — which would
// otherwise ride every broadcast. A take hands the full item back.
const toPublicItem = (item) => {
  const publicItem = { id: item.id, createdAt: item.createdAt, content: item.content, text: item.text };
  if (item.agentMention) publicItem.agentMention = item.agentMention;
  // Consult state rides the projection so every client sees what is reserved,
  // by whom, and what the consult will carry.
  if (item.kind) publicItem.kind = item.kind;
  if (item.consult) publicItem.consult = item.consult;
  if (item.claimed) publicItem.claimed = item.claimed;
  // Recovery marker: only a consult item that lost its reservation (a lapsed
  // hold or a restart) exposes it, so clients can offer re-claim or removal.
  if (isConsultItem(item) && item.recoverable) publicItem.recoverable = true;
  publicItem.attachments = item.attachments.map(toPublicAttachment);
  // Older persisted items have no UI summary. Prefer their attached comment
  // before falling back to the model-facing context text.
  const contextPreview = item.contextPreview || item.context
    .filter((part) => part.kind !== 'instruction')
    .map((part) => asNonEmptyString(asRecord(part.metadata?.openchamberContext)?.text) || part.text.trim())
    .find(Boolean);
  if (contextPreview) {
    const firstLine = contextPreview.split('\n', 1)[0];
    publicItem.contextPreview = firstLine.slice(0, 100)
      + (contextPreview.length > firstLine.length || firstLine.length > 100 ? '...' : '');
  }
  publicItem.sendConfig = { ...item.sendConfig };
  return publicItem;
};

const extractSessionStatus = (payload) => {
  if (payload.type !== 'session.status') return null;
  const properties = asRecord(payload.properties) ?? {};
  const status = asRecord(properties.status) ?? {};
  const info = asRecord(properties.info) ?? {};
  const sessionId = asNonEmptyString(properties.sessionID);
  const type = asNonEmptyString(status.type) || asNonEmptyString(info.type);
  if (!sessionId || !type) return null;
  return { sessionId, type };
};

const extractAssistantMessageUpdate = (payload) => {
  if (payload.type !== 'message.updated') return null;
  const info = asRecord(asRecord(payload.properties)?.info);
  if (!info || info.role !== 'assistant') return null;
  const sessionId = asNonEmptyString(info.sessionID);
  if (!sessionId) return null;
  return {
    sessionId,
    aborted: asRecord(info.error)?.name === 'MessageAbortedError',
    completed: asCount(asRecord(info.time)?.completed) !== null,
  };
};

const extractDeletedSessionId = (payload) => {
  if (payload.type !== 'session.deleted') return null;
  const properties = asRecord(payload.properties) ?? {};
  return asNonEmptyString(asRecord(properties.info)?.id) || asNonEmptyString(properties.sessionID) || null;
};

export function createMessageQueueRuntime({
  globalEventHub,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  sessionKnowledgeRuntime = null,
  broadcastGlobalUiEvent,
  onPromptSent,
  // Turns the `openchamber/auto` model into a real one right before the send;
  // absent means the queue never sees the sentinel.
  resolvePromptBody = null,
  dataDir,
  fetchImpl = fetch,
  now = Date.now,
  dispatchQuietMs = DISPATCH_QUIET_MS,
  abortHoldMs = ABORT_HOLD_MS,
  retryDelayMs = getQueuedSendRetryDelayMs,
}) {
  const filePath = path.join(dataDir, QUEUE_FILE_NAME);

  /** sessionId → { directory, items } */
  const queues = new Map();
  let revision = 0;
  let loadPromise = null;
  let writePromise = Promise.resolve();
  let stopped = false;

  // An unfinished assistant message older than this marker is a run that died
  // with the previous server, not a streaming turn: no completion event will
  // ever arrive for it, so treating it as live strands restored queue items
  // forever. A run that outlived the restart (external OpenCode) is still
  // caught by the live status check, which runs first.
  const runtimeStartedAt = now();

  /** In-memory only — a restart has no in-flight sends. */
  const sending = new Map(); // sessionId → itemId
  const timers = new Map(); // sessionId → timeout
  const failures = new Map(); // sessionId → { itemId, failures, nextAttemptAt }
  const abortedAt = new Map(); // sessionId → timestamp
  // sessionId → Map<owner, expiresAt>. Several independent UI processes (and
  // several consult runs) can hold one session at once; a release removes only
  // the caller's own owner, and the session stays held while any owner has a
  // live TTL. The empty-string owner is the legacy owner-less slot, so callers
  // that never send an owner keep today's behavior for their own slot. Owners
  // lapse on their own TTL and are pruned on every hold mutation; one session
  // holds at most MAX_HOLD_OWNERS_PER_SESSION owners.
  const holds = new Map();
  // sessionId → directory, kept after the queue empties: the UI keys its
  // projection by directory, so the broadcast that removes the last item must
  // still name it or the client cannot tell which queue just finished.
  const directories = new Map();

  // --- persistence ---------------------------------------------------------

  const serialize = () => ({
    version: QUEUE_FILE_VERSION,
    revision,
    sessions: Object.fromEntries(
      Array.from(queues.entries()).map(([sessionId, queue]) => [sessionId, { directory: queue.directory, items: queue.items }]),
    ),
  });

  const readFile = async () => {
    let raw;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if (asRecord(error)?.code === 'ENOENT') return { sessions: {}, revision: 0 };
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // Malformed is a failure, not an empty queue: keep the bytes for the
      // user and start over rather than overwriting them on the next write.
      const backup = `${filePath}.corrupt-${now()}`;
      await fs.promises.rename(filePath, backup).catch(() => undefined);
      console.warn(`[message-queue] queue file was unreadable and moved to ${backup}: ${error?.message ?? error}`);
      return { sessions: {}, revision: 0 };
    }
    const stored = asRecord(parsed) ?? {};
    const sessions = {};
    for (const [sessionId, value] of Object.entries(asRecord(stored.sessions) ?? {})) {
      const entry = asRecord(value);
      if (!entry || !isValidSessionId(sessionId)) continue;
      const directory = asNonEmptyString(entry.directory);
      const items = (asList(entry.items) ?? []).map(parseStoredItem).filter(Boolean);
      if (!directory || items.length === 0) continue;
      sessions[sessionId] = { directory, items };
    }
    return { sessions, revision: asCount(stored.revision) ?? 0 };
  };

  const load = () => {
    if (!loadPromise) {
      loadPromise = readFile()
        .then((stored) => {
          for (const [sessionId, entry] of Object.entries(stored.sessions)) {
            // Holds are memory-only, so no persisted consult reservation can
            // survive a restart: a restored consult item comes back unclaimed,
            // but it stays a consult item (kind kept, stale claimed/system
            // dropped) and is therefore never tick-delivered. The receipt
            // metadata survives: it is the run's delivery-correlation identity,
            // so a Resume can re-check whether the pre-restart dispatch already
            // landed before it re-fans-out. A restored one is recoverable: its
            // reservation is gone, so a client may re-claim it (the claim route
            // accepts an unclaimed head consult) or the user may remove it.
            for (const item of entry.items) {
              delete item.claimed;
              dropStaleConsultSynthesis(item);
              if (isConsultItem(item)) item.recoverable = true;
            }
            queues.set(sessionId, entry);
          }
          revision = Math.max(revision, stored.revision);
        })
        .catch((error) => {
          // A read failure keeps the in-memory (empty) queue but must not be
          // mistaken for "nothing queued": the next write would clobber the
          // file, so writes stay disabled until a later load succeeds.
          loadPromise = null;
          throw error;
        });
    }
    return loadPromise;
  };

  const persist = () => {
    const payload = JSON.stringify(serialize());
    writePromise = writePromise
      .then(async () => {
        await fs.promises.mkdir(dataDir, { recursive: true });
        const tmpPath = `${filePath}.${process.pid}.tmp`;
        await fs.promises.writeFile(tmpPath, payload, 'utf8');
        await fs.promises.rename(tmpPath, filePath);
      })
      .catch((error) => {
        console.warn('[message-queue] failed to persist queue:', error?.message ?? error);
      });
    return writePromise;
  };

  // --- snapshots -----------------------------------------------------------

  const sessionSnapshot = (sessionId) => {
    // The read path sweeps: a snapshot must not show a claim the hold map can
    // no longer back. The cleared claim is persisted when something changed.
    if (clearLapsedConsultClaims(sessionId)) commit(sessionId);
    const queue = queues.get(sessionId);
    return {
      sessionId,
      directory: queue?.directory ?? directories.get(sessionId) ?? '',
      items: (queue?.items ?? []).map(toPublicItem),
      sendingId: sending.get(sessionId) ?? null,
    };
  };

  const snapshot = () => ({
    revision,
    sessions: Array.from(queues.keys()).map(sessionSnapshot),
  });

  const broadcast = (sessionId) => {
    broadcastGlobalUiEvent?.({
      type: 'openchamber:message-queue.updated',
      properties: { revision, session: sessionSnapshot(sessionId) },
    });
  };

  /** Every mutation goes through here: bump, persist, broadcast. */
  const commit = (sessionId) => {
    revision += 1;
    void persist();
    broadcast(sessionId);
    return { revision, session: sessionSnapshot(sessionId) };
  };

  const setQueueItems = (sessionId, directory, items) => {
    directories.set(sessionId, directory);
    if (items.length === 0) {
      queues.delete(sessionId);
      return;
    }
    queues.set(sessionId, { directory, items });
  };

  // --- OpenCode access -----------------------------------------------------

  const openCodeFetch = async (fetchPath, { directory, method = 'GET', body, query } = {}) => {
    const base = buildOpenCodeUrl(fetchPath, '');
    const params = new URLSearchParams(query || {});
    if (directory) params.set('directory', directory);
    const search = params.toString();
    const headers = { Accept: 'application/json', ...getOpenCodeAuthHeaders() };
    const init = { method, headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) };
    if (body) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetchImpl(search ? `${base}?${search}` : base, init);
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw httpError(`OpenCode ${method} ${fetchPath} failed with ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`, response.status);
    }
    return response.json().catch(() => null);
  };

  /**
   * Live idleness, or null when it could not be established. Unknown is never
   * idle: a fetch failure re-arms instead of sending into a running turn.
   */
  const isSessionIdle = async (sessionId, directory) => {
    const statuses = asRecord(await openCodeFetch('/session/status', { directory }).catch(() => null));
    if (!statuses) return null;
    const type = asRecord(statuses[sessionId])?.type;
    if (type === 'busy' || type === 'retry') return false;
    // The status map lists only busy sessions, so a missed busy event leaves
    // no entry while a turn still streams. The trailing unfinished assistant
    // message is the live evidence of that turn (mirrors the UI gate).
    const messages = asList(await openCodeFetch(`/session/${encodeURIComponent(sessionId)}/message`, {
      directory,
      query: { limit: String(MESSAGE_TAIL_LIMIT) },
    }).catch(() => null));
    if (!messages) return null;
    const last = asRecord(asRecord(messages[messages.length - 1])?.info);
    const lastTime = asRecord(last?.time);
    if (last?.role === 'assistant' && asCount(lastTime?.completed) === null) {
      const created = asCount(lastTime?.created);
      if (created === null || created >= runtimeStartedAt) return false;
      // Unfinished tail from before this runtime started: its run died with
      // the previous server, so it must not block delivery. (A missing
      // created timestamp stays conservative and blocks, as before.)
      console.log(`[message-queue] ignoring pre-boot unfinished tail for ${sessionId}`);
    }
    return true;
  };

  const resolveSlashCommand = async (text, directory) => {
    if (!text.startsWith('/')) return null;
    const [head, ...tail] = text.split(' ');
    const name = head.slice(1);
    if (!name) return null;
    const commands = asList(await openCodeFetch('/command', { directory })) ?? [];
    const match = commands.map(asRecord).find((command) => command?.name === name);
    if (!match) return null;
    return {
      name,
      arguments: tail.join(' '),
      isSkill: match.source === 'skill',
      template: asNonEmptyString(match.template),
    };
  };

  /**
   * The prompt a slash command stands for, expanded the way OpenCode expands
   * it: `$ARGUMENTS` takes the whole argument string, `$1..$N` take quoted or
   * bare words with the last position absorbing the rest, and a template with
   * no placeholder gets the arguments appended. Twin of the UI's
   * `expandSlashCommandGoalObjective` in `packages/ui/src/sync/session-ui-store.ts`.
   */
  const expandCommandTemplate = (template, argumentsText) => {
    if (template.includes('$ARGUMENTS')) return template.replaceAll('$ARGUMENTS', argumentsText);
    const positions = [...template.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
    if (positions.length > 0) {
      const parsed = [...argumentsText.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)]
        .map((match) => match[1] ?? match[2] ?? match[3] ?? '');
      const last = Math.max(...positions);
      return template.replace(/\$(\d+)/g, (_match, value) => {
        const position = Number(value);
        return position === last ? parsed.slice(position - 1).join(' ') : (parsed[position - 1] ?? '');
      });
    }
    return argumentsText ? `${template}\n\n${argumentsText}` : template;
  };

  const toFilePart = (attachment) => ({
    type: 'file',
    mime: attachment.mimeType,
    filename: attachment.filename,
    url: attachment.dataUrl,
  });

  // Captured context is delivered the way the composer delivers it: one
  // synthetic text part per entry, an attached item's metadata riding along
  // and its reading instructions (a linked PR) going first.
  const toContextParts = (part) => {
    const synthetic = { type: 'text', text: part.text, synthetic: true };
    if (part.kind !== 'context') return [synthetic];
    synthetic.metadata = part.metadata;
    return part.instructions
      ? [{ type: 'text', text: part.instructions, synthetic: true }, synthetic]
      : [synthetic];
  };

  /**
   * The prompt_async body for an item, shared by the generic dispatcher and
   * the consult dispatch: the same part order a UI send uses, plus the
   * consult extras — a top-level `system` and the consult metadata riding the
   * primary text part the way a context part carries its metadata.
   */
  const buildPromptBody = async (item, { sessionId, directory, fileParts, contextParts, command, system = '', textPartMetadata }) => {
    let text = item.text;
    const commandParts = [];
    if (command?.isSkill) {
      commandParts.push({
        type: 'text',
        text: `The user explicitly invoked the ${command.name} skill. Use the corresponding skill tool to handle this request.`,
        synthetic: true,
      });
    } else if (command?.template) {
      text = expandCommandTemplate(command.template, command.arguments);
    }

    // Standing project context rides the prompt exactly as a UI send would
    // attach it; a failed lookup sends without it rather than not at all.
    const knowledge = sessionKnowledgeRuntime
      ? await sessionKnowledgeRuntime.resolvePendingForSession(sessionId, directory)
        .catch(() => ({ text: '', signature: '' }))
      : { text: '', signature: '' };
    // Same order as a UI send: the user's text and files, the context queued
    // with them, then the standing context, then the mentioned agent.
    const parts = [];
    if (text.trim()) parts.push({ type: 'text', text });
    parts.push(...fileParts);
    parts.push(...contextParts);
    parts.push(...commandParts);
    if (knowledge.text) parts.push({ type: 'text', text: knowledge.text, synthetic: true });
    if (item.agentMention) parts.push({ type: 'agent', name: item.agentMention });
    if (textPartMetadata !== undefined) {
      // Only a text part can carry metadata: OpenCode's file parts have no
      // metadata field. Attach to the first existing text part (user text, or
      // a command/context part that got there first) only while it carries no
      // metadata of its own — overwriting a captured-context part's payload
      // would lose it. Otherwise (the context-part case and the no-text-part
      // attachment-only case) insert one synthetic carrier part before the
      // files so the receipt (for consults) still lands and the tail
      // correlation by runId stays possible.
      const firstText = parts.find((part) => part.type === 'text');
      if (firstText && firstText.metadata === undefined) {
        firstText.metadata = textPartMetadata;
      } else {
        const carrier = {
          type: 'text',
          text: CONSULT_RECEIPT_CARRIER_TEXT,
          synthetic: true,
          metadata: textPartMetadata,
        };
        const firstFile = parts.findIndex((part) => part.type === 'file');
        if (firstFile === -1) parts.push(carrier);
        else parts.splice(firstFile, 0, carrier);
      }
    }
    const { providerID, modelID, agent, variant } = item.sendConfig;
    const body = { model: { providerID, modelID } };
    if (agent) body.agent = agent;
    if (variant) body.variant = variant;
    if (system) body.system = system;
    body.parts = parts;
    return { body, knowledge };
  };

  const sendItem = async (sessionId, directory, item) => {
    const { providerID, modelID, agent, variant } = item.sendConfig;
    const fileParts = item.attachments.map(toFilePart);
    const contextParts = item.context.flatMap(toContextParts);
    // OpenCode's command route takes file parts only, so a command queued
    // with captured context cannot go through it. Same rule as the composer:
    // without context the command route keeps its semantics; with context the
    // prompt route carries the expanded template (or the skill invocation as an
    // explicit instruction) together with the context.
    const command = await resolveSlashCommand(item.text, directory);
    if (command && contextParts.length === 0) {
      const body = { command: command.name, arguments: command.arguments, model: `${providerID}/${modelID}` };
      if (agent) body.agent = agent;
      if (variant) body.variant = variant;
      if (fileParts.length > 0) body.parts = fileParts;
      await resolvePromptBody?.(body, { sessionId, directory });
      await openCodeFetch(`/session/${encodeURIComponent(sessionId)}/command`, { directory, method: 'POST', body });
      return;
    }
    const { body, knowledge } = await buildPromptBody(item, { sessionId, directory, fileParts, contextParts, command });
    await resolvePromptBody?.(body, { sessionId, directory });
    await openCodeFetch(`/session/${encodeURIComponent(sessionId)}/prompt_async`, { directory, method: 'POST', body });
    if (knowledge.text && sessionKnowledgeRuntime) {
      // After the prompt is accepted, so a rejected dispatch carries it again.
      await sessionKnowledgeRuntime.recordDelivered(sessionId, directory, knowledge.signature).catch(() => undefined);
    }
  };

  // --- dispatch loop -------------------------------------------------------

  const clearTimer = (sessionId) => {
    const existing = timers.get(sessionId);
    if (existing) {
      clearTimeout(existing);
      timers.delete(sessionId);
    }
  };

  const armDispatch = (sessionId, delayMs = dispatchQuietMs) => {
    if (stopped || !queues.has(sessionId)) return;
    clearTimer(sessionId);
    const timer = setTimeout(() => {
      timers.delete(sessionId);
      tick(sessionId).catch((error) => {
        console.warn('[message-queue] dispatch tick failed:', error?.message ?? error);
      });
    }, Math.max(0, delayMs));
    timer.unref?.();
    timers.set(sessionId, timer);
  };

  /**
   * Consult items whose reservation died lose the claim and the stale
   * synthesis, but keep `kind: 'consult'` and the receipt metadata: the user's
   * consult intent survives a lapsed reservation, so the item is still never
   * handed to a raw send — the generic dispatcher skips it and only an
   * explicit remove/clear deletes it. The cleared item is marked
   * `recoverable`: it lost its owner, so a client may re-claim it through the
   * claim route or the user may remove it. An item that was never claimed
   * keeps waiting for its flow to claim it.
   * Runs inside the expiry sweep, so the tick and every hold mutation both see
   * the cleared claims immediately.
   */
  const clearLapsedConsultClaims = (sessionId) => {
    const queue = queues.get(sessionId);
    if (!queue) return false;
    let changed = false;
    for (const item of queue.items) {
      if (!isConsultItem(item) || !item.claimed) continue;
      // The stored owner is the hold-map key as-is; the empty string is the
      // legacy owner-less slot, which counts while its hold is live.
      const owner = asNonEmptyString(item.claimed.owner);
      if (liveHoldOwners(sessionId)?.has(owner)) continue;
      delete item.claimed;
      dropStaleConsultSynthesis(item);
      item.recoverable = true;
      changed = true;
    }
    return changed;
  };

  /**
   * Drop every lapsed owner across every session. A read prunes only the
   * session it touches, so without this sweep an owner on a session that never
   * dispatches (no queue, no further hold traffic) would sit in the map until
   * the process ends. Every hold mutation runs it, which bounds the map to
   * live owners (plus at most one mutation's worth of lapsed ones). A lapsed
   * owner also ends its consult item's reservation: the claim and the stale
   * synthesis are cleared (committed/broadcast) while the item keeps kind
   * 'consult' and its receipt metadata, so it can never be delivered raw and
   * a Resume can still correlate the acting turn it belonged to.
   */
  const pruneExpiredHolds = () => {
    const nowMs = now();
    const revertedSessions = new Set();
    for (const [sessionId, owners] of holds) {
      for (const [owner, expiresAt] of owners) {
        if (expiresAt <= nowMs) owners.delete(owner);
      }
      if (owners.size === 0) holds.delete(sessionId);
      if (clearLapsedConsultClaims(sessionId)) revertedSessions.add(sessionId);
    }
    for (const sessionId of revertedSessions) commit(sessionId);
  };

  /**
   * Prune expired owners and return the session's live owner map, or null when
   * nothing holds it. Expiry is lazy: every read drops what has lapsed, so the
   * map cannot grow past the owners that are actually holding.
   */
  const liveHoldOwners = (sessionId) => {
    const owners = holds.get(sessionId);
    if (!owners) return null;
    const nowMs = now();
    for (const [owner, expiresAt] of owners) {
      if (expiresAt <= nowMs) owners.delete(owner);
    }
    if (owners.size === 0) {
      holds.delete(sessionId);
      return null;
    }
    return owners;
  };

  /**
   * Lazy expiry sweep for one session's read path: drops lapsed owners and
   * clears consult claims whose reservation died, so a snapshot or a tick
   * never sees a claim the hold map can no longer back. (Hold mutations sweep
   * every session via pruneExpiredHolds; this covers sessions that only get
   * read.)
   */
  const sweepSession = (sessionId) => {
    if (!liveHoldOwners(sessionId)) {
      clearLapsedConsultClaims(sessionId);
      return;
    }
    clearLapsedConsultClaims(sessionId);
  };

  const isHeld = (sessionId) => liveHoldOwners(sessionId) !== null;

  /**
   * True while the session has a consult item whose claim owner still holds a
   * live reservation. Read-only within the runtime (the lazy hold read prunes
   * lapsed owners as usual; items are never mutated). The proxy's prompt gate
   * uses this to keep direct prompt calls from starting a turn while a
   * Consult Models run owns the session.
   */
  const hasActiveConsultReservation = (sessionIdInput) => {
    const sessionId = asNonEmptyString(sessionIdInput);
    if (!isValidSessionId(sessionId)) return false;
    const queue = queues.get(sessionId);
    if (!queue) return false;
    const owners = liveHoldOwners(sessionId);
    if (!owners) return false;
    return queue.items.some((item) => {
      if (item.kind !== CONSULT_ITEM_KIND || !item.claimed) return false;
      // The stored owner is the hold-map key as-is; the empty string is the
      // legacy owner-less slot, which counts while its hold is live.
      return owners.has(asNonEmptyString(item.claimed.owner));
    });
  };

  /**
   * Index of the item the generic dispatcher may send, or null. Consult items
   * are never tick-delivered — they wait for their own claim → dispatch route.
   * The deliverable head is the first normal item, and it never jumps over a
   * consult item: a claimed consult blocks while its hold is live, and a
   * lapsed (unreserved) one keeps blocking too — the sweep clears only the
   * claim and payload, never the kind, so a consult item can never become a
   * normal send.
   */
  const firstDeliverableIndex = (sessionId, items) => {
    const owners = liveHoldOwners(sessionId);
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item.kind !== CONSULT_ITEM_KIND) return index;
      const owner = asNonEmptyString(item.claimed?.owner);
      if (!owner || !owners?.has(owner)) return null;
    }
    return null;
  };

  async function tick(sessionId) {
    if (stopped) return;
    // The tick's read path sweeps this session: lapsed owners go, and the
    // claims/payloads of consult items with dead reservations are cleared
    // (their kind stays, so they are still never delivered by the tick).
    sweepSession(sessionId);
    const queue = queues.get(sessionId);
    if (!queue || queue.items.length === 0 || sending.has(sessionId) || isHeld(sessionId)) return;

    const abortHoldUntil = (abortedAt.get(sessionId) ?? 0) + abortHoldMs;
    if (abortHoldUntil > now()) {
      armDispatch(sessionId, abortHoldUntil - now());
      return;
    }

    const items = queue.items;
    const headIndex = firstDeliverableIndex(sessionId, items);
    if (headIndex === null) return;
    const head = items[headIndex];
    const failure = failures.get(sessionId);
    if (failure && failure.itemId !== head.id) failures.delete(sessionId);
    else if (failure && failure.nextAttemptAt > now()) {
      armDispatch(sessionId, failure.nextAttemptAt - now());
      return;
    }

    const idle = await isSessionIdle(sessionId, queue.directory);
    if (idle === null) {
      armDispatch(sessionId, retryDelayMs(1));
      return;
    }
    // Busy: the next idle status event re-arms the loop.
    if (!idle) return;

    // Re-read after the awaits — the user may have edited the queue meanwhile,
    // and a hold may have landed while this tick was between its first check
    // and the idleness round-trips. The hold is authoritative at the moment of
    // sending: without this check a hold asserted mid-tick would not stop the
    // send it was asserted to prevent.
    const current = queues.get(sessionId);
    const currentIndex = current ? firstDeliverableIndex(sessionId, current.items) : null;
    const item = currentIndex === null ? null : current.items[currentIndex];
    if (!item || item.id !== head.id || sending.has(sessionId) || isHeld(sessionId)) return;

    sending.set(sessionId, item.id);
    broadcast(sessionId);
    try {
      await sendItem(sessionId, current.directory, item);
      const after = queues.get(sessionId);
      if (after) setQueueItems(sessionId, after.directory, after.items.filter((entry) => entry.id !== item.id));
      failures.delete(sessionId);
      sending.delete(sessionId);
      commit(sessionId);
      try {
        onPromptSent?.(sessionId);
      } catch {
        // bookkeeping only
      }
      console.log(`[message-queue] sent queued message to ${sessionId}`);
    } catch (error) {
      sending.delete(sessionId);
      const count = (failure?.itemId === item.id ? failure.failures : 0) + 1;
      const nextAttemptAt = now() + retryDelayMs(count);
      failures.set(sessionId, { itemId: item.id, failures: count, nextAttemptAt });
      console.warn(`[message-queue] send to ${sessionId} failed (attempt ${count}):`, error?.message ?? error);
      broadcast(sessionId);
      armDispatch(sessionId, nextAttemptAt - now());
    }
  }

  const reconcileAll = () => {
    for (const sessionId of queues.keys()) {
      if (!timers.has(sessionId)) armDispatch(sessionId, dispatchQuietMs);
    }
  };

  // --- public mutations ----------------------------------------------------

  const requireSessionId = (sessionId) => {
    if (!isValidSessionId(sessionId)) throw new TypeError('sessionId is invalid');
    return sessionId;
  };

  const enqueue = async (sessionIdInput, directoryInput, itemInput) => {
    const sessionId = requireSessionId(sessionIdInput);
    const directory = asNonEmptyString(directoryInput);
    if (!directory) throw new TypeError('directory is required');
    const parsed = parseQueuedItemInput(itemInput);
    await load();
    const item = {
      id: `queued-${now()}-${Math.random().toString(36).slice(2, 9)}`,
      createdAt: now(),
      ...parsed,
    };
    const existing = queues.get(sessionId);
    const existingItems = existing?.items ?? [];
    let items;
    if (existingItems.length < MAX_ITEMS_PER_SESSION) {
      items = [...existingItems, item];
    } else {
      // A consult item is never silently evicted: drop the oldest normal item
      // instead, and refuse the enqueue when every slot holds a consultation.
      const evictIndex = existingItems.findIndex((entry) => entry.kind !== CONSULT_ITEM_KIND);
      if (evictIndex === -1) {
        throw httpError('cannot queue message: the queue is full of pending consultations', 409);
      }
      items = existingItems.filter((_, index) => index !== evictIndex);
      items.push(item);
    }
    const hadSession = queues.has(sessionId);
    queues.set(sessionId, { directory, items });
    directories.set(sessionId, directory);
    if (queues.size > MAX_SESSIONS) {
      // A session with an in-flight send, a live hold, or any consult item is
      // never evicted: dropping it would discard authoritative queued work
      // (a consultation waiting for its own dispatch route).
      const oldest = Array.from(queues.entries())
        .filter(([id, queue]) =>
          id !== sessionId
          && !sending.has(id)
          && !isHeld(id)
          && !queue.items.some((entry) => entry.kind === CONSULT_ITEM_KIND))
        .sort((left, right) => (left[1].items[0]?.createdAt ?? 0) - (right[1].items[0]?.createdAt ?? 0))
        .slice(0, queues.size - MAX_SESSIONS);
      if (oldest.length === 0 && !hadSession) {
        // Nothing safe to evict and this call created the session: roll the
        // just-added entry back so a refused enqueue leaves no phantom queue.
        queues.delete(sessionId);
        directories.delete(sessionId);
        clearTimer(sessionId);
        throw httpError('cannot queue message: the queue is full of active sessions', 409);
      }
      for (const [staleId] of oldest) {
        queues.delete(staleId);
        clearTimer(staleId);
        broadcast(staleId);
        directories.delete(staleId);
      }
    }
    const result = commit(sessionId);
    // The session may already be idle (queued from a busy-looking composer
    // right as the turn ended); the tick verifies before sending.
    armDispatch(sessionId);
    // The authoritative created item rides the response, so a caller never
    // has to re-derive it from a snapshot diff.
    return { ...result, itemId: item.id, item };
  };

  /**
   * Manual removal is a full cancellation of the removed consult items'
   * reservations: the item's own claim owner hold is cleared in the same
   * mutation (the stored owner is already the hold-map key; the owner-less
   * legacy slot included). Other owners' holds and normal items are
   * untouched.
   */
  const releaseClaimsOfRemovedItems = (sessionId, removedItems) => {
    const owners = liveHoldOwners(sessionId);
    if (!owners) return;
    let changed = false;
    for (const item of removedItems) {
      if (item.kind !== CONSULT_ITEM_KIND || !item.claimed) continue;
      const owner = asNonEmptyString(item.claimed.owner);
      if (owners.delete(owner)) changed = true;
    }
    if (!changed) return;
    if (owners.size === 0) holds.delete(sessionId);
    // Removing the item may make the queue dispatchable again.
    armDispatch(sessionId);
  };

  const remove = async (sessionIdInput, itemId) => {
    const sessionId = requireSessionId(sessionIdInput);
    await load();
    if (sending.get(sessionId) === itemId) throw httpError('message is being sent', 409);
    const queue = queues.get(sessionId);
    const removed = queue?.items.find((item) => item.id === itemId);
    if (!queue || !removed) {
      return { revision, session: sessionSnapshot(sessionId) };
    }
    setQueueItems(sessionId, queue.directory, queue.items.filter((item) => item.id !== itemId));
    releaseClaimsOfRemovedItems(sessionId, [removed]);
    return commit(sessionId);
  };

  /** Removes the item and hands its full payload (attachments included) back. */
  const take = async (sessionIdInput, itemId) => {
    const sessionId = requireSessionId(sessionIdInput);
    await load();
    if (sending.get(sessionId) === itemId) throw httpError('message is being sent', 409);
    const queue = queues.get(sessionId);
    const item = queue?.items.find((entry) => entry.id === itemId);
    if (!queue || !item) throw httpError('queued message not found', 404);
    // A consult item is only ever sent through its own dispatch route; a take
    // would hand it to a raw-send client and lose the consult intent.
    if (item.kind === CONSULT_ITEM_KIND) throw httpError('cannot take queued message: consult-item', 409);
    setQueueItems(sessionId, queue.directory, queue.items.filter((entry) => entry.id !== itemId));
    return { ...commit(sessionId), item };
  };

  /**
   * Removes every normal item not currently being sent and hands them back in
   * order. Consult items are never taken: they wait for their own dispatch
   * route (or an explicit remove/clear by the user).
   */
  const takeAll = async (sessionIdInput) => {
    const sessionId = requireSessionId(sessionIdInput);
    await load();
    const queue = queues.get(sessionId);
    if (!queue) return { revision, session: sessionSnapshot(sessionId), items: [] };
    const sendingId = sending.get(sessionId) ?? null;
    const items = queue.items.filter((item) => item.id !== sendingId && item.kind !== CONSULT_ITEM_KIND);
    if (items.length === 0) return { revision, session: sessionSnapshot(sessionId), items: [] };
    const takenIds = new Set(items.map((item) => item.id));
    setQueueItems(sessionId, queue.directory, queue.items.filter((item) => !takenIds.has(item.id)));
    return { ...commit(sessionId), items };
  };

  const reorder = async (sessionIdInput, itemIds) => {
    const sessionId = requireSessionId(sessionIdInput);
    if (!asList(itemIds) || itemIds.some((id) => !asNonEmptyString(id))) {
      throw new TypeError('itemIds must be a list of ids');
    }
    await load();
    const queue = queues.get(sessionId);
    if (!queue) return { revision, session: sessionSnapshot(sessionId) };
    const byId = new Map(queue.items.map((item) => [item.id, item]));
    if (itemIds.length !== byId.size || new Set(itemIds).size !== itemIds.length || itemIds.some((id) => !byId.has(id))) {
      throw new TypeError('itemIds must list every queued message exactly once');
    }
    queues.set(sessionId, { directory: queue.directory, items: itemIds.map((id) => byId.get(id)) });
    return commit(sessionId);
  };

  const clear = async (sessionIdInput) => {
    const sessionId = requireSessionId(sessionIdInput);
    await load();
    const queue = queues.get(sessionId);
    if (!queue) return { revision, session: sessionSnapshot(sessionId) };
    // Never drop a message already handed to OpenCode: its send resolves and
    // must find its entry.
    const sendingId = sending.get(sessionId) ?? null;
    const removed = queue.items.filter((item) => item.id !== sendingId);
    setQueueItems(sessionId, queue.directory, queue.items.filter((item) => item.id === sendingId));
    releaseClaimsOfRemovedItems(sessionId, removed);
    clearTimer(sessionId);
    return commit(sessionId);
  };

  /**
   * The hold owner a request names. Owner-less requests use the empty-string
   * slot, which is the whole map for a client that never sends an owner (the
   * legacy semantics). A present-but-invalid owner is refused instead of being
   * silently folded into that slot, so a malformed owner cannot clear or
   * extend another owner's hold.
   */
  const parseHoldOwner = (value) => {
    if (value === undefined || value === null) return '';
    const owner = asNonEmptyString(value);
    if (!owner || owner.length > 128) throw new TypeError('owner must be a non-empty string');
    return owner;
  };

  const setHold = (sessionIdInput, held, ttlMs = HOLD_DEFAULT_TTL_MS, ownerInput = undefined) => {
    const sessionId = requireSessionId(sessionIdInput);
    if (held !== true && held !== false) throw new TypeError('held must be a boolean');
    const owner = parseHoldOwner(ownerInput);
    // Every hold mutation sweeps lapsed owners, including sessions that are
    // never read again, so the owner map cannot accumulate indefinitely.
    pruneExpiredHolds();
    if (held) {
      const ttl = Math.min(asCount(ttlMs) || HOLD_DEFAULT_TTL_MS, HOLD_MAX_TTL_MS);
      let owners = liveHoldOwners(sessionId);
      if (!owners) {
        owners = new Map();
        holds.set(sessionId, owners);
      }
      // A re-assert of an existing owner extends its own TTL and never counts
      // as a new slot; a genuinely new owner beyond the cap is refused rather
      // than silently dropping or clearing a hold someone still relies on.
      if (!owners.has(owner) && owners.size >= MAX_HOLD_OWNERS_PER_SESSION) {
        throw httpError(`session already has ${MAX_HOLD_OWNERS_PER_SESSION} hold owners`, 429);
      }
      owners.set(owner, now() + ttl);
      clearTimer(sessionId);
      return { held: true, expiresAt: owners.get(owner) };
    }
    const owners = liveHoldOwners(sessionId);
    if (owners) {
      owners.delete(owner);
      if (owners.size === 0) holds.delete(sessionId);
    }
    // Releasing one owner never clears the others; the dispatch is armed only
    // as a re-check, and the tick bails while any owner still holds.
    armDispatch(sessionId);
    return { held: isHeld(sessionId), expiresAt: null };
  };

  const refuseClaim = (reason) => httpError(`cannot claim queued message: ${reason}`, 409);

  /**
   * Reserves a consult item for one owner: the item is marked claimed and the
   * owner's hold is (re)started, which is what keeps the generic dispatcher
   * away and what the expiry sweep later reads. Only the queue head can be
   * claimed, and only while the session is idle — the same gate the tick
   * applies before it sends. A lapsed/reservation-lost item (recoverable) is
   * claimable again by a fresh owner; that re-claim clears the marker.
   */
  const claim = async (sessionIdInput, itemId, ownerInput, ttlMs = HOLD_DEFAULT_TTL_MS) => {
    const sessionId = requireSessionId(sessionIdInput);
    await load();
    // The owner comparison for `already-claimed` folds only null/undefined
    // into the legacy slot, mirroring parseHoldOwner; a present-but-malformed
    // owner still reaches its own refusal below.
    const rawOwner = ownerInput === undefined || ownerInput === null ? '' : ownerInput;
    const checkItem = () => {
      const queue = queues.get(sessionId);
      const index = queue ? queue.items.findIndex((entry) => entry.id === itemId) : -1;
      const item = index >= 0 ? queue.items[index] : null;
      if (!item) throw refuseClaim('not found');
      if (item.kind !== CONSULT_ITEM_KIND) throw refuseClaim('not-consult');
      if (index !== 0) throw refuseClaim('not-head');
      if (sending.has(sessionId)) throw refuseClaim('sending');
      return item;
    };

    let item = checkItem();
    if (item.claimed && rawOwner !== item.claimed.owner) throw refuseClaim('already-claimed');
    const owner = parseHoldOwner(ownerInput);
    const queue = queues.get(sessionId);
    // Unknown is never idle: a failed status read refuses the claim instead of
    // reserving the item against a session that may be mid-turn.
    if ((await isSessionIdle(sessionId, queue.directory)) !== true) throw refuseClaim('not-idle');
    // Re-verify after the await — the queue may have moved under us, and a
    // concurrent claim of the same item must lose, not win silently.
    item = checkItem();
    if (item.claimed && rawOwner !== item.claimed.owner) throw refuseClaim('already-claimed');
    // The hold is acquired BEFORE the item is marked claimed: setHold sweeps
    // lapsed owners, and a mark written before its owner exists could be
    // reverted by that same sweep while the claim still reports success.
    // setHold caps the TTL at HOLD_MAX_TTL_MS and defaults it; a re-claim by
    // the same owner extends its existing slot instead of taking a new one.
    // An owner-less claim (empty string) maps onto the legacy hold slot by
    // omitting the owner, matching the hold map's own normalization.
    setHold(sessionId, true, ttlMs, owner || undefined);
    item.claimed = { owner, claimedAt: now() };
    // A re-claim of a recoverable item is a resume: the reservation is live
    // again, so the recovery marker goes. The hold was set first (setHold
    // sweeps lapsed owners), so the sweep cannot re-mark it recoverable.
    if (item.recoverable) delete item.recoverable;
    commit(sessionId);
    return { claimed: true, item };
  };

  /**
   * Merges the consult payload of a claimed item while its owner still holds
   * it: the claim flow may update the system prompt or text metadata between
   * claim and dispatch without re-queueing the item.
   */
  const setConsultPayload = async (sessionIdInput, itemId, ownerInput, payloadInput) => {
    const sessionId = requireSessionId(sessionIdInput);
    const owner = parseHoldOwner(ownerInput);
    await load();
    const queue = queues.get(sessionId);
    const item = queue?.items.find((entry) => entry.id === itemId);
    if (!item) throw httpError('cannot update consult payload: not found', 409);
    if (item.kind !== CONSULT_ITEM_KIND) throw httpError('cannot update consult payload: not-consult', 409);
    if (!item.claimed || item.claimed.owner !== owner) {
      throw httpError('cannot update consult payload: not-claiming', 409);
    }
    if (sending.has(sessionId)) throw httpError('cannot update consult payload: sending', 409);
    item.consult = { ...item.consult, ...parseConsultPayload(payloadInput) };
    return { ok: true, item, ...commit(sessionId) };
  };

  /** Wait bound for dispatchConsult's idle loop, mirroring the fetch timeout. */
  const CONSULT_DISPATCH_IDLE_CAP_MS = 60_000;
  const CONSULT_DISPATCH_POLL_MS = 200;

  /**
   * The consult item's own dispatch route: it was never going to be sent by
   * the generic tick, so the claim owner asks for it explicitly. The session
   * must go idle first — the same isSessionIdle gate the tick applies — and
   * every re-verification after an await keeps a lapsed reservation, a
   * concurrent send, or a removed item from stealing the dispatch.
   */
  /** Gap between delivery-confirmation polls; four polls bound the wait at ~1.6 s. */
  const CONSULT_DELIVERY_CONFIRM_DELAY_MS = 400;
  const CONSULT_DELIVERY_CONFIRM_ATTEMPTS = 4;
  /**
   * Confirmation reads a wider tail than the idle check: a landed prompt's
   * user message can fall out of a two-message window while the assistant
   * turn streams behind it, which would falsely read as "not delivered".
   */
  const CONSULT_DELIVERY_TAIL_LIMIT = 20;

  /**
   * The acting turn's receipt runId, extracted from the item's consult
   * payload metadata. This is the only non-heuristic correlation between a
   * failed prompt and the user message it created; null means correlation is
   * impossible (no text carrier, no metadata) and the outcome must never
   * become 'no' from a timeout alone.
   */
  const readConsultReceiptRunId = (item) => {
    const carrier = asRecord(item.consult?.textPartMetadata);
    const receipt = asRecord(carrier?.openchamberConsultReceipt);
    // The UI receipt contract (`synthesis.ts` `consultReceiptSchema`) spells
    // this field `runID`; the carrier key is `openchamberConsultReceipt`.
    return asNonEmptyString(receipt?.runID) || null;
  };

  /**
   * Marker correlation for an ambiguous prompt failure: read the parent tail
   * the way `isSessionIdle` does and look for a user message whose text part
   * metadata carries this dispatch's receipt runId. Returns true (marker
   * found), false (the read succeeded and no marker is present), or null
   * (the read failed — never guess).
   */
  const hasConsultDeliveryMarker = async (sessionId, directory, runId, limit = CONSULT_DELIVERY_TAIL_LIMIT) => {
    const messages = asList(await openCodeFetch(`/session/${encodeURIComponent(sessionId)}/message`, {
      directory,
      query: { limit: String(limit) },
    }).catch(() => null));
    if (!messages) return null;
    for (const entry of messages) {
      const record = asRecord(entry);
      const info = asRecord(record?.info);
      if (!info || info.role !== 'user') continue;
      const parts = asList(record?.parts) ?? [];
      for (const part of parts) {
        const metadata = asRecord(asRecord(part)?.metadata);
        const receipt = asRecord(metadata?.openchamberConsultReceipt);
        // Same field as the reader above (the UI's `runID`).
        if (asNonEmptyString(receipt?.runID) === runId) return true;
      }
    }
    return false;
  };

  /**
   * Poll for this dispatch's delivery marker. Returns true (found), false
   * (every read succeeded, none carries the marker), or null (any read
   * failed — indeterminable, never guessed).
   */
  const confirmConsultDelivery = async (sessionId, directory, runId) => {
    for (let attempt = 0; attempt < CONSULT_DELIVERY_CONFIRM_ATTEMPTS; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, CONSULT_DELIVERY_CONFIRM_DELAY_MS));
      const found = await hasConsultDeliveryMarker(sessionId, directory, runId);
      if (found === null) return null;
      if (found) return true;
    }
    return false;
  };

  /**
   * The consult item's own dispatch route: it was never going to be sent by
   * the generic tick, so the claim owner asks for it explicitly. Every
   * control-flow answer is a structured outcome (HTTP 200) instead of a
   * thrown status: the caller decides whether to re-poll. The session must go
   * idle first — the same isSessionIdle gate the tick applies — and every
   * re-verification after an await keeps a lapsed reservation, a concurrent
   * send, or a removed item from stealing the dispatch.
   */
  const dispatchConsult = async (sessionIdInput, itemId, ownerInput) => {
    const sessionId = requireSessionId(sessionIdInput);
    await load();
    const owner = parseHoldOwner(ownerInput);

    /**
     * Entry order: not-found → not-consult → claim-lost → sending. A missing
     * claim, another owner, or a lapsed reservation all read as claim-lost;
     * nothing is mutated on any refusal.
     */
    const inspect = () => {
      const queue = queues.get(sessionId);
      const item = queue ? queue.items.find((entry) => entry.id === itemId) : null;
      if (!item) return { kind: 'not-found' };
      if (item.kind !== CONSULT_ITEM_KIND) return { kind: 'not-consult' };
      if (!item.claimed || item.claimed.owner !== owner) return { kind: 'claim-lost' };
      if (sending.has(sessionId)) return { kind: 'sending' };
      if (!liveHoldOwners(sessionId)?.has(owner)) return { kind: 'claim-lost' };
      return { kind: 'ok', item, queue };
    };

    const entry = inspect();
    if (entry.kind !== 'ok') return { status: entry.kind };
    const item = entry.item;
    const directory = entry.queue.directory;
    // The dispatch itself is the reservation's last use: extend it to the cap
    // so the wait-for-idle below cannot be starved by a TTL the owner set low.
    // An owner-less claim keeps using the legacy hold slot.
    setHold(sessionId, true, HOLD_MAX_TTL_MS, owner || undefined);

    // Bounded idle wait. Busy at entry or on expiry leaves the claim and the
    // item untouched, so the owner can retry the dispatch later.
    const deadline = now() + CONSULT_DISPATCH_IDLE_CAP_MS;
    for (;;) {
      const idle = await isSessionIdle(sessionId, directory);
      const state = inspect();
      if (state.kind !== 'ok') return { status: state.kind };
      if (idle === true) break;
      if (idle === false) return { status: 'busy' };
      if (now() >= deadline) return { status: 'busy' };
      await new Promise((resolve) => setTimeout(resolve, CONSULT_DISPATCH_POLL_MS));
    }

    const removeItem = () => {
      const after = queues.get(sessionId);
      if (after) setQueueItems(sessionId, after.directory, after.items.filter((entry) => entry.id !== item.id));
    };
    const releaseOwnerHold = () => setHold(sessionId, false, undefined, owner || undefined);

    sending.set(sessionId, item.id);
    broadcast(sessionId);
    // The receipt runId is this acting turn's identity in the parent
    // transcript; null means correlation is impossible (see below).
    const consultRunId = readConsultReceiptRunId(item);
    try {
      const fileParts = item.attachments.map(toFilePart);
      const contextParts = item.context.flatMap(toContextParts);
      const command = await resolveSlashCommand(item.text, directory);
      // A consult prompt always takes the prompt route: its system/metadata
      // extras have no command-route equivalent.
      const { body } = await buildPromptBody(item, {
        sessionId,
        directory,
        fileParts,
        contextParts,
        command: command && command.isSkill ? command : null,
        system: item.consult?.system ?? '',
        textPartMetadata: item.consult?.textPartMetadata,
      });
      await resolvePromptBody?.(body, { sessionId, directory });
      await openCodeFetch(`/session/${encodeURIComponent(sessionId)}/prompt_async`, { directory, method: 'POST', body });
      removeItem();
      sending.delete(sessionId);
      releaseOwnerHold();
      commit(sessionId);
      try {
        onPromptSent?.(sessionId);
      } catch {
        // bookkeeping only
      }
      console.log(`[message-queue] sent consult message to ${sessionId}`);
      return { status: 'dispatched', item };
    } catch (error) {
      sending.delete(sessionId);
      console.warn(`[message-queue] consult send to ${sessionId} failed:`, error?.message ?? error);
      // The prompt may have been accepted before the failure surfaced: poll
      // the parent tail for this acting turn's receipt marker. Correlation is
      // only possible with a runId; without one a timeout must never become
      // 'no' — only an explicit HTTP rejection can prove non-acceptance.
      const delivered = consultRunId
        ? await confirmConsultDelivery(sessionId, directory, consultRunId)
        : null;
      if (delivered === true) {
        // Landed despite the failed response: the dispatch succeeded.
        removeItem();
        releaseOwnerHold();
        commit(sessionId);
        try {
          onPromptSent?.(sessionId);
        } catch {
          // bookkeeping only
        }
        console.log(`[message-queue] consult send to ${sessionId} landed after a reported failure`);
        return { status: 'dispatched', item, delivery: 'confirmed-after-failure' };
      }
      // A read failure is always indeterminate, even with an HTTP status: the
      // transcript could not be checked, so acceptance cannot be disproven.
      const readFailed = delivered === null && consultRunId !== null;
      // 'no' requires PROVABLE non-acceptance, never just a rejection status:
      // an HTTP 4xx means the server rejected the request before accepting it,
      // and a connection-level failure means the request never reached the
      // server. A 5xx may have been accepted before the error surfaced, and a
      // timeout/abort or an unknown error shape proves nothing.
      const rejectionStatus = asCount(asRecord(error)?.status);
      const connectionCode = asNonEmptyString(asRecord(asRecord(error)?.cause)?.code);
      const neverAccepted = (
        (rejectionStatus !== null && rejectionStatus >= 400 && rejectionStatus < 500)
        || connectionCode === 'ECONNREFUSED'
        || connectionCode === 'ENOTFOUND'
        || connectionCode === 'EAI_AGAIN'
      );
      if (!readFailed && neverAccepted) {
        // Proven non-acceptance: with correlation the marker reads also found
        // nothing; without a runId this proof is the only path to 'no'.
        removeItem();
        releaseOwnerHold();
        commit(sessionId);
        return { status: 'send-failed', delivered: 'no' };
      }
      // Indeterminate: an unreadable tail, a 5xx, a timeout/abort, or any
      // unclassifiable failure. Keep the item, the claim, and the hold; never
      // guess a removal, and never derive 'no' from a timeout.
      broadcast(sessionId);
      return { status: 'send-failed', delivered: 'unknown' };
    }
  };

  /**
   * Deeper tail for reconnect-time resolution: a client that died after an
   * ambiguous dispatch can reconnect much later, by which time the marker may
   * have fallen out of the dispatch's 20-message window while newer turns
   * streamed in behind it.
   */
  const CONSULT_RESOLVE_TAIL_LIMIT = 200;

  /**
   * Reconnect-time reconciliation for a consult item stranded by an ambiguous
   * dispatch (the client died between send and confirmation and nobody
   * re-checked the tail). This is an outcome check, not a send: it never
   * prompts, and it never touches a live claim.
   *
   * Entry order mirrors dispatchConsult's inspect but WITHOUT the owner gate —
   * the claiming client may be gone, which is the whole point — and stops at
   * an in-flight send, which may still be the one that lands the marker.
   *
   * The marker read awaits, so the decision is re-checked against the queue
   * afterwards: a claim or dispatch that started meanwhile owns the item now,
   * and acting on the stale read would clobber that live reservation. On any
   * change (item gone, claim identity different, a send in flight) the outcome
   * stays undecided and nothing is mutated.
   *
   * Outcomes, all evidence-based and all fail-closed:
   * - `not-found` / `not-consult` / `sending`: nothing is mutated.
   * - No receipt runId in the item metadata: correlation is impossible, so the
   *   indeterminate state must stay — `{ status: 'unresolved' }` untouched.
   * - Marker found in a deeper tail (200): the dispatch landed — remove the
   *   item exactly once, release the claimed owner's hold (a non-empty owner
   *   only: an unclaimed or owner-less item has no own slot, and the shared
   *   legacy slot is never cleared from here), commit, broadcast.
   * - Marker absent and the item is unclaimed: the reservation is gone and
   *   there is no evidence of delivery — mark `recoverable` and answer
   *   `{ status: 'unresolved', recoverable: true }`; the item keeps blocking
   *   the head and clients may Resume or remove it.
   * - Marker absent but the item is still claimed: the owning client may still
   *   be mid-flight — `{ status: 'unresolved' }`, its lease is untouched.
   * - Marker read failed, or the item/claim changed during the read: never
   *   guess — `{ status: 'unresolved' }`, the live reservation decides.
   */
  const resolveConsult = async (sessionIdInput, itemIdInput) => {
    const sessionId = requireSessionId(sessionIdInput);
    await load();

    const queue = queues.get(sessionId);
    const item = queue ? queue.items.find((entry) => entry.id === itemIdInput) : null;
    if (!item) return { status: 'not-found' };
    if (item.kind !== CONSULT_ITEM_KIND) return { status: 'not-consult' };
    if (sending.has(sessionId)) return { status: 'sending' };

    // The receipt runId is the only non-heuristic correlation between the item
    // and a prompt that may have landed; without it nothing can be decided.
    const runId = readConsultReceiptRunId(item);
    if (!runId) return { status: 'unresolved' };

    // The claim identity this decision is based on, so the post-read re-check
    // can tell a concurrent claim, re-claim, or release from "unchanged".
    const entryClaim = item.claimed ?? null;
    const found = await hasConsultDeliveryMarker(sessionId, queue.directory, runId, CONSULT_RESOLVE_TAIL_LIMIT);
    if (found === null) return { status: 'unresolved' };

    // The tail read awaited: a claim or dispatch that started meanwhile owns
    // the item now, and removing it (or releasing its hold) would clobber that
    // live reservation. Proceed only on the same item, with the same claim
    // (same owner and claimedAt, or both absent), and no send in flight.
    const current = queues.get(sessionId);
    const currentItem = current ? current.items.find((entry) => entry.id === itemIdInput) : null;
    const currentClaim = currentItem?.claimed ?? null;
    const claimUnchanged = (
      (entryClaim === null && currentClaim === null)
      || (
        entryClaim !== null
        && currentClaim !== null
        && entryClaim.owner === currentClaim.owner
        && entryClaim.claimedAt === currentClaim.claimedAt
      )
    );
    if (!currentItem || sending.has(sessionId) || !claimUnchanged) return { status: 'unresolved' };

    if (found) {
      // Delivered: remove exactly once (the filter drops nothing else), then
      // release the claim owner's hold. Only a claimed item with a non-empty
      // owner has a hold slot of its own to release: an unclaimed item maps
      // onto no owner, and the shared owner-less legacy slot must not be
      // cleared on another feature's behalf.
      setQueueItems(sessionId, current.directory, current.items.filter((entry) => entry.id !== currentItem.id));
      const claimedOwner = asNonEmptyString(currentItem.claimed?.owner);
      if (claimedOwner) setHold(sessionId, false, undefined, claimedOwner);
      commit(sessionId);
      console.log(`[message-queue] resolved stranded consult message in ${sessionId} as delivered`);
      return { status: 'dispatched', delivered: 'confirmed' };
    }
    if (!currentItem.claimed) {
      // The reservation is gone (lapse or restart) and the tail shows no
      // marker: no evidence of delivery. Surface the recovery hint and leave
      // the item exactly as it was — a consult item still blocking the head.
      currentItem.recoverable = true;
      commit(sessionId);
      return { status: 'unresolved', recoverable: true };
    }
    // Still claimed with a live hold: the owning client may still be mid-flight.
    return { status: 'unresolved' };
  };

  // --- events --------------------------------------------------------------

  const processPayload = (value) => {
    const payload = asRecord(value);
    if (stopped || !payload) return;

    const deletedSessionId = extractDeletedSessionId(payload);
    if (deletedSessionId) {
      if (!queues.has(deletedSessionId)) return;
      queues.delete(deletedSessionId);
      clearTimer(deletedSessionId);
      failures.delete(deletedSessionId);
      holds.delete(deletedSessionId);
      commit(deletedSessionId);
      directories.delete(deletedSessionId);
      return;
    }

    const status = extractSessionStatus(payload);
    if (status) {
      if (!queues.has(status.sessionId)) return;
      if (status.type === 'idle') armDispatch(status.sessionId);
      else clearTimer(status.sessionId);
      return;
    }

    const assistant = extractAssistantMessageUpdate(payload);
    if (assistant && queues.has(assistant.sessionId)) {
      if (assistant.aborted) abortedAt.set(assistant.sessionId, now());
      // A completed reply without a following idle status (missed event)
      // must still drain the queue; the tick verifies idleness itself.
      if (assistant.completed && !timers.has(assistant.sessionId)) armDispatch(assistant.sessionId);
    }
  };

  const processEvent = (event) => {
    const raw = asRecord(asRecord(event)?.payload);
    processPayload(asRecord(raw?.payload) ?? raw);
  };

  const start = () => {
    const unsubscribeEvent = globalEventHub.subscribeEvent(processEvent);
    const unsubscribeStatus = globalEventHub.subscribeStatus((status) => {
      if (status?.type === 'connect') reconcileAll();
    });
    void load()
      .then(() => {
        if (queues.size > 0) console.log(`[message-queue] restored queues for ${queues.size} session(s)`);
        reconcileAll();
      })
      .catch((error) => {
        console.warn('[message-queue] failed to load queue file:', error?.message ?? error);
      });
    return () => {
      unsubscribeEvent();
      unsubscribeStatus();
    };
  };

  const stop = () => {
    stopped = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };

  return {
    load,
    snapshot,
    sessionSnapshot,
    enqueue,
    remove,
    take,
    takeAll,
    reorder,
    clear,
    setHold,
    claim,
    setConsultPayload,
    dispatchConsult,
    resolveConsult,
    hasActiveConsultReservation,
    processPayload,
    start,
    stop,
    /** Drains the pending write; tests and shutdown use it. */
    flush: () => writePromise,
  };
}

export function registerMessageQueueRoutes(app, runtime) {
  const respondError = (res, error, fallback) => {
    const status = error instanceof TypeError ? 400 : (Number.isInteger(error?.status) ? error.status : 500);
    res.status(status).json({ error: error?.message ?? fallback });
  };

  app.get('/api/message-queue', async (_req, res) => {
    try {
      await runtime.load();
      res.json(runtime.snapshot());
    } catch (error) {
      respondError(res, error, 'Failed to load message queue');
    }
  });

  app.post('/api/message-queue/sessions/:sessionId/items', async (req, res) => {
    try {
      res.json(await runtime.enqueue(req.params.sessionId, req.body?.directory, req.body?.item));
    } catch (error) {
      respondError(res, error, 'Failed to queue message');
    }
  });

  app.post('/api/message-queue/sessions/:sessionId/take', async (req, res) => {
    try {
      res.json(await runtime.takeAll(req.params.sessionId));
    } catch (error) {
      respondError(res, error, 'Failed to take queued messages');
    }
  });

  app.put('/api/message-queue/sessions/:sessionId/order', async (req, res) => {
    try {
      res.json(await runtime.reorder(req.params.sessionId, req.body?.itemIds));
    } catch (error) {
      respondError(res, error, 'Failed to reorder queue');
    }
  });

  app.put('/api/message-queue/sessions/:sessionId/hold', async (req, res) => {
    try {
      await runtime.load();
      res.json(runtime.setHold(req.params.sessionId, req.body?.held, req.body?.ttlMs, req.body?.owner));
    } catch (error) {
      respondError(res, error, 'Failed to update queue hold');
    }
  });

  app.delete('/api/message-queue/sessions/:sessionId', async (req, res) => {
    try {
      res.json(await runtime.clear(req.params.sessionId));
    } catch (error) {
      respondError(res, error, 'Failed to clear queue');
    }
  });

  app.post('/api/message-queue/sessions/:sessionId/items/:itemId/take', async (req, res) => {
    try {
      res.json(await runtime.take(req.params.sessionId, req.params.itemId));
    } catch (error) {
      respondError(res, error, 'Failed to take queued message');
    }
  });

  app.post('/api/message-queue/sessions/:sessionId/items/:itemId/claim', async (req, res) => {
    try {
      await runtime.load();
      res.json(await runtime.claim(req.params.sessionId, req.params.itemId, req.body?.owner, req.body?.ttlMs));
    } catch (error) {
      respondError(res, error, 'Failed to claim queued message');
    }
  });

  app.post('/api/message-queue/sessions/:sessionId/items/:itemId/payload', async (req, res) => {
    try {
      await runtime.load();
      res.json(await runtime.setConsultPayload(req.params.sessionId, req.params.itemId, req.body?.owner, req.body?.consult));
    } catch (error) {
      respondError(res, error, 'Failed to update consult payload');
    }
  });

  app.post('/api/message-queue/sessions/:sessionId/items/:itemId/dispatch-consult', async (req, res) => {
    try {
      await runtime.load();
      // Every control-flow answer is a structured outcome carried by HTTP 200;
      // only malformed requests (400) or unexpected failures (500) are errors.
      res.json(await runtime.dispatchConsult(req.params.sessionId, req.params.itemId, req.body?.owner));
    } catch (error) {
      respondError(res, error, 'Failed to dispatch consult message');
    }
  });

  app.post('/api/message-queue/sessions/:sessionId/items/:itemId/resolve-consult', async (req, res) => {
    try {
      await runtime.load();
      // Same structured-outcome contract as dispatch-consult: reconnect-time
      // reconciliation never sends and never errors on control-flow cases.
      res.json(await runtime.resolveConsult(req.params.sessionId, req.params.itemId));
    } catch (error) {
      respondError(res, error, 'Failed to resolve consult message');
    }
  });

  app.delete('/api/message-queue/sessions/:sessionId/items/:itemId', async (req, res) => {
    try {
      res.json(await runtime.remove(req.params.sessionId, req.params.itemId));
    } catch (error) {
      respondError(res, error, 'Failed to remove queued message');
    }
  });
}
