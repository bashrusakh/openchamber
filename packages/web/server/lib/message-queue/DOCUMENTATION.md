# Message Queue

## Purpose

Owns the messages a user queued while a session was busy, and sends them the
moment the session goes idle. The queue lives in the web server so a closed
tab, a locked phone, or a dropped connection no longer strands it. Structural
template: `permission-auto-accept` — the server is authoritative, the shared UI
renders a projection, and VS Code (which has no server of its own) keeps its
UI-side queue and foreground auto-send hook.

## Files

- `runtime.js` — `createMessageQueueRuntime(...)` (state, persistence,
  dispatch loop, event handling) and `registerMessageQueueRoutes(app, runtime)`.
- `runtime.test.js` — delivery, idleness gates, retries, holds, persistence,
  concurrency with in-flight sends, slash commands, and project knowledge.

Wiring: created in `server/index.js` after the global event hub and the
session-knowledge runtime; routes registered in
`opencode/feature-routes-runtime.js` (before the generic OpenCode proxy) with
JSON bodies enabled in `opencode/core-routes.js`; stopped by
`opencode/shutdown-runtime.js`.

## Auto routing

`resolvePromptBody` (the routing runtime) runs on the assembled body right
before the prompt or command send, turning a queued `openchamber/auto` model
into a real one. The queue captures the sentinel like any other send config.

## Item

An item is what the UI would have sent itself, captured at queue time so the
send never re-resolves mutable UI state:

```
{
  id, createdAt,
  content,        // raw text for display and editing
  contextPreview?, // bounded display-only summary captured by the UI
  text,           // text to deliver (agent mention stripped, file mentions resolved); defaults to content
  agentMention?,  // delivered as an `agent` part
  attachments: [{ id, filename, mimeType, size, source, serverPath?, dataUrl }],
  context: [      // what the composer had attached, in send order
    { kind: 'context', text, metadata, instructions? },  // a draft chip or linked issue/PR; metadata is the UI's structured payload
    { kind: 'instruction', text },                       // derived from the text (skill instruction)
    { kind: 'synthetic', text },                         // handed to the composer by another surface
  ],
  sendConfig: { providerID, modelID, agent?, variant? }   // required
}
```

The server is a courier for `context`: it validates the shape (a kind it
knows, a `metadata` object on `context` entries) and delivers each entry as a
synthetic text part, an entry's `instructions` going out as its own part just
before it and its `metadata` riding the part verbatim so the timeline renders
the context block back. The payload inside `metadata` is the UI's contract
(`lib/messages/contextParts.ts`), parsed by the UI on the way back.

`parseQueuedItemInput` rejects anything the server could not deliver later
(no text, attachments, or context; missing model; malformed attachment or
context entry). Public snapshots and broadcasts strip the payloads —
attachment `dataUrl` (megabytes of base64) and `context` (a PR diff, say) —
so they do not ride every update; the only way to get them back is a `take`.

Snapshots retain `contextPreview`, capped at 100 characters plus an ellipsis.
It carries the attached comment or context label when `content` is empty and
never replaces editable text or delivered parts. Older items without a summary
derive one from the attached comment metadata or the first non-instruction
context text. This optional field needs no queue-file migration.

## Persistence

`<data-dir>/message-queue.json` (`OPENCHAMBER_DATA_DIR` or
`~/.config/openchamber`): `{ version, revision, sessions: { [sessionId]:
{ directory, items } } }`, written atomically (temp file + rename) through a
serialized write chain. A missing file is an empty queue. A malformed file is
a failure, not an empty queue: it is moved aside as
`message-queue.json.corrupt-<timestamp>` before the runtime starts empty, so
the next write cannot overwrite the user's data. A failed read leaves writes
disabled until a later load succeeds. `revision` is a global monotonic counter
bumped on every mutation; clients use it to reject stale snapshots.

The file format is version 2. A file whose version is above the runtime's own
is moved aside like malformed data (its fields cannot be trusted to this
build), and a version-1 or version-absent file is read with the legacy rule:
every restored consult item gets a legacy dispatch witness, because the old
build's fire-and-forget persist means a missing attempt record is not proof
that no dispatch was attempted (see "Consult items").

In-memory only, deliberately: the in-flight item (`sendingId`), retry
backoff, abort timestamps, and holds. A restart has no in-flight sends; a
persisted "sending" flag would strand a message forever.

## Delivery loop

1. `start()` subscribes to the global upstream hub and loads the file; on
   load and on every hub `connect` it arms every session that has items.
2. `session.status` for a queued session: `idle` arms a short quiet timer
   (500 ms, coalescing the burst around a turn boundary), `busy`/`retry`
   clears it. A `message.updated` for a completed assistant reply arms as
   well, so a missed idle event cannot strand the queue. `session.deleted`
   drops the session's queue. An assistant `MessageAbortedError` records an
   abort.
3. `tick(sessionId)` bails when the queue is empty, an item is in flight, or
   the session is held (by any owner). It re-arms after a 2 s post-abort hold
   (the UI's old behavior: a stop is not immediately followed by the next
   prompt) or while the head item is in retry backoff.
4. Idleness is re-verified against OpenCode before sending, because
   `prompt_async` into a running turn steers into it instead of starting the
   next one: `GET /session/status` must not list the session as busy/retry,
   and the trailing message must not be an unfinished assistant reply (the
   status map only lists busy sessions, so a missed busy event leaves no
   entry while a turn still streams). An unfinished reply created before this
   runtime started does not block: its run died with the previous server and
   will never complete, so a restored queue would wait on it forever. A reply
   with no `created` time still blocks. A failed fetch is unknown, never idle:
   the tick re-arms with backoff.
5. The head is marked in flight (broadcast), then sent:
   - text starting with `/` that names a command in OpenCode's `/command`
     list (skills included) and carries no captured context goes to
     `POST /session/:id/command` with the captured model, agent, variant, and
     file parts. That route accepts file parts only, so a command queued
     **with** context takes the prompt route instead, the same rule the
     composer applies: the command's template is expanded with its arguments
     (`$ARGUMENTS`, `$1..$N`, or appended), a skill keeps its `/name args` text
     and gets an explicit "the user invoked this skill" synthetic part after
     the context;
   - otherwise `POST /session/:id/prompt_async` with the parts in the same
     order a UI send uses: text, files, the captured context, the skill
     invocation when there is one, pending project knowledge
     (`sessionKnowledgeRuntime.resolvePendingForSession`, synthetic, recorded
     as delivered only after the prompt is accepted), then the agent mention.
   Success removes the item, persists, broadcasts, and marks the user
   message sent for notifications. Failure keeps the item, backs off
   2 s → 60 s (doubling per consecutive failure of that item), and re-arms.
6. The next item goes out after the next busy → idle cycle.

## Holds

Auto-review is driven from the UI and bounces the original session through
idle between iterations; the UI tells the server to hold that session's queue
(`PUT .../hold { held: true, ttlMs? }`) while a run is going and releases it
when the run ends. A hold expires on its own (default 5 min, cap 10 min)
because the UI that asserted it may be gone; the UI re-asserts it every two
minutes while the run continues. Releasing arms a dispatch, which the tick
re-checks.

Holds are owner-scoped: an optional `owner` string names the independent UI
process asserting the hold, and the server keeps one TTL per
`(sessionId, owner)`. The session is held while **any** owner has a live TTL,
so two features (auto-review, a Consult Models run) holding the same session
cannot clear each other's protection: each release removes only the caller's
own owner. A request without an `owner` uses the legacy owner-less slot and
behaves exactly as before for that slot. A present-but-malformed owner
(blank, non-string, over 128 characters) is refused with a `400`, so it
cannot silently clear or extend another owner's hold. Expired owners are
pruned lazily on every hold read and, across every session, on every hold
mutation, so owners on sessions that are never read again do not accumulate.
One session holds at most `MAX_HOLD_OWNERS_PER_SESSION` (8) owners; a
genuinely new owner beyond the cap is refused with a `429` rather than
silently dropping or clearing a hold someone still relies on, and a re-assert
of an existing owner always fits. Deleting a session drops its holds.

The hold is authoritative at send time, not just when the dispatch timer is
armed: `tick` re-checks it after the idleness round-trips, so a hold that
lands while a tick is in flight stops that send.

## Consult items

A consult item is enqueued by a consult flow (Consult Models) and dispatched
only through its own claim → payload → dispatch route. The generic dispatcher
never sends it. Three optional fields extend the item:

```
kind: 'consult'              // only the literal 'consult' is accepted; absent = normal
consult: { system?, textPartMetadata?, attempt? }  // model-facing payload + dispatch witness
claimed: { owner, claimedAt }            // set by a successful claim
```

`consult.system` is a string capped at 24 000 characters;
`consult.textPartMetadata` is carried as JSON capped at 8 000 serialized
characters and must be serializable. Violations are TypeErrors (→ 400), the
same contract as every other item field. `kind`, `consult`, and `claimed` ride
snapshots, broadcasts, and the JSON round-trip.

`CONSULT_PROTOCOL_VERSION` (exported by `runtime.js`) is the backend half of the
Consult Models capability handshake: the version route exposes it as
`consultProtocol` on `GET /api/opencode/version`. Bump it whenever the consult
queue protocol changes in a way an older UI cannot handle; the UI fails closed
when the field is absent or below its required value.

The enqueue route itself does not perform this handshake — the composer gate
and the submission's own re-check are what keep a backend that predates
`kind: 'consult'` from ever receiving one; a direct HTTP enqueue that bypasses
both is outside the capability contract (on a protocol-1 backend the
never-raw-send rule in "Dispatcher skip rule" still holds).

### Dispatch witness (`consult.attempt`)

`consult.attempt` is the durable record that a dispatch request may have been
issued for this item:

```
attempt: {
  attemptId,    // att_ + random; the server's own mutation identity
  messageId,    // msg_ + random; the request's OpenCode message id
  at,           // when the witness was written
  legacy?,      // true: restored from a version-1 file, no messageId
}
```

The record carries only what a decision reads; the claim owner is not stored
here (decisions read the item's own `claimed`).

The server writes it and only the server writes it: `parseConsultPayload` (the
enqueue parser and the `/payload` merge) copies just `system` and
`textPartMetadata`, so a client-supplied attempt is silently stripped, and the
stored-item parser is the only reader. It is written by `dispatchConsult` in a
single strict, awaited write (`commitAttempt` uses `persistStrict`, which
rejects to the caller instead of swallowing the failure like the ordinary
fire-and-forget `persist`), and the prompt request is only issued after that
write lands. If the write fails, the dispatch answers
`{ status: 'attempt-write-failed' }` and sends nothing: no request may exist
without a durable witness. Because the write is awaited, `dispatchConsult`
re-inspects right after it: a removal, a lost claim, or a send that started
during the write is never overtaken by the request.

The dispatch runs in two phases with different failure semantics. Preparation
(`resolveSlashCommand`, `buildPromptBody`, the routing hook) never crosses the
request boundary, so a preparation failure unwinds the witness (only while it
is still this dispatch's own attemptId), removes the item, releases the owner
hold, and answers `send-failed delivered: 'no'` — it never runs the delivery
poll. Only a failure of `prompt_async` or after it may keep the witness and
answer `unknown` (a 4xx or connection-refused rejection of `prompt_async` still
classifies as proven not-accepted and clears the witness, below).

Four committed sites clear or drop the witness, and nothing else does
(`resolveConsult` only reads it):

- the dispatch's proven-rejection path (a 4xx or `ECONNREFUSED`/`ENOTFOUND`/
  `EAI_AGAIN`), which also removes the item and answers
  `send-failed delivered: 'no'`;
- the preparation-failure unwind described above (ownership-checked);
- the post-write re-inspect, when the claim was lost (or another send took the
  session) while the witness write was awaited: this dispatch sent nothing, so
  it deletes its own witness, marks the item `recoverable` when it ends
  unclaimed and unwitnessed, and commits — which unblocks the item and shows
  the Resume affordance;
- the `commitAttempt` rollback when the strict write itself rejects, which
  leaves no in-memory witness behind (the request is never issued).

A foreign witness is never touched by any cleanup: the attemptId recorded on
the item decides.

Its absence is the server's only proof that a consult item was never
dispatched, so that is what gates a resume (see "Recovery"). A stored attempt
record that is present but unreadable is normalized at the stored-item boundary
to the conservative legacy witness, never to "never sent". While a witness
stands the item is not claimable and carries no `recoverable`: `claim` refuses
`attempt-recorded` (409) and `dispatchConsult` refuses `attempt-present` (200),
both re-checked after every await. The only ways a witness disappears are the
proven-rejection path and the dispatch's own-write claim-lost cleanup; after
either, the item is legitimately resumable again. The witness survives a lapsed
reservation and a restart (only `claimed` and the stale synthesis drop), which
is what keeps a restart from licensing a duplicate resume.

Delivery of a witnessed item is proven by one of two reads:

- the address check `GET /session/{id}/message/{messageId}` returning 200 —
  OpenCode admits a message under the id the request carried, so a readable
  address proves the turn landed. This is the dispatch failure path's bounded
  poll and the modern-witness resolve read;
- the receipt-marker tail read (secondary): the acting turn's
  `consult.textPartMetadata` marker found in the parent transcript, used for
  legacy witnesses, which have no addressable message id.

A 404 on the address check is not proof of non-delivery. The A0 probe showed
that ordinary operations (`DELETE /session/{id}/message/{id}`, and a
revert-to-message followed by any new prompt) make a landed message read 404,
so anything other than 200 leaves the outcome unknown and the item, claim, and
witness in place. There is no time window and no revert-marker read: unknown
is a permanent answer until a later read says otherwise or the user removes
the item, and the client's only safe action on a witnessed item is removal.

### Dispatcher skip rule

`tick` sends only normal items, and only the *deliverable head*: the first
normal item is deliverable only while every item before it is a consult item
whose claim owner still holds a live reservation. A claimed consult therefore
blocks the items queued behind it (FIFO is preserved — the normal item never
jumps ahead), and a consult item whose reservation lapsed keeps blocking even
after the sweep clears the claim: the item stays a consult item and is never
tick-delivered. A consult message never goes out raw.

### Reserving and dispatching

`claim(sessionId, itemId, owner, ttlMs = 5 min)` reserves the head consult
item for one owner: it marks the item claimed, starts/refreshes that owner's
hold (TTL capped at 10 min), and the same-owner re-claim extends the
reservation. Only the queue head can be claimed, only while the session is
idle (the same `isSessionIdle` gate the tick applies; a failed status read is
"unknown, never idle" and refuses), and never an item that already carries a
dispatch witness (409 `attempt-recorded`; re-checked after the idle read, so a
witness that appears mid-claim wins and the claim refuses). The claim never
writes or clears the witness. `setConsultPayload` merges
`item.consult` while the item is claimed by that owner and not in flight —
the claim flow may refine the system prompt or text metadata between claim
and dispatch. Manual removal is a full cancellation of the item's own
reservation: `remove`/`clear` release the removed consult item's claim owner
hold in the same mutation (the stored owner key, including the owner-less
legacy slot), while other owners' holds and normal items stay untouched.

`dispatchConsult(sessionId, itemId, owner)` sends the consult item on the
owner's explicit request and answers every control-flow case as a structured
outcome under HTTP 200 (only malformed requests are 400 and unexpected
failures 500):

| Outcome | Meaning |
|---|---|
| `{ status: 'dispatched', item, evidence: 'admission' }` | sent and removed; the owner hold was released and the result committed/broadcast. A `delivery: 'confirmed-after-failure'` with `evidence: 'address'` or `'marker'` marks a send whose response failed but whose delivery was proven afterwards. |
| `{ status: 'busy' }` | the session was busy at entry or the bounded idle wait (60 s) expired; the claim and item are untouched. |
| `{ status: 'claim-lost' }` | the item has no claim, another owner claims it, or the reservation hold is not live (checked at entry and after every await). |
| `{ status: 'not-found' }` | the item does not exist. |
| `{ status: 'not-consult' }` | the item is not a consult item. |
| `{ status: 'attempt-present' }` | the item already carries a dispatch witness, so a request for it may already exist; nothing is mutated and no request is issued (checked at entry and after every await, before `sending`). |
| `{ status: 'attempt-write-failed' }` | the strict witness write failed, so no request was issued; the item and claim are untouched. |
| `{ status: 'sending' }` | the session already has an item in flight. |
| `{ status: 'send-failed', delivered: 'no' }` | the prompt definitely did not land; the witness was cleared, the item removed, and the hold released. |
| `{ status: 'send-failed', delivered: 'unknown' }` | the prompt may or may not have landed; the item, claim, hold, and witness stay reserved for a resolve. The client deliberately leaves the owner lease to the server (resolution or expiry) instead of releasing it, so the proxy prompt gate keeps protecting a session whose send may still be running. |

A prompt failure does not immediately decide the outcome. Before the request
the dispatch writes the witness' `messageId`, so the primary check is the
address: up to four reads of `GET /session/{id}/message/{messageId}` ~400 ms
apart (~1.6 s total), any 200 proving the turn landed. The acting turn's
receipt marker stays as the secondary signal: the dispatch extracts the receipt
`runId` from the item's `textPartMetadata` (`openchamberConsultReceipt`) and
also polls the parent tail for a user message whose text-part metadata carries
that same `runId`. Both names are exact, so another client's concurrent message
can never be mistaken for the dispatch.

- Address 200 or marker found → the send landed: `dispatched` with
  `delivery: 'confirmed-after-failure'` and `evidence: 'address'` or
  `'marker'` (item removed, hold released like a normal success).
- Neither found and the failure PROVES the request was never accepted →
  `send-failed delivered: 'no'` (witness cleared, item removed, hold released,
  no raw or queued re-delivery). Only two kinds of failure prove that: an HTTP
  4xx (the server rejected the request before accepting it) and a
  connection-level failure before the request reached the server
  (`error.cause.code` of `ECONNREFUSED`, `ENOTFOUND`, or `EAI_AGAIN`). A
  legacy witness (no message id to check) never takes this path.
- Every other failure — an HTTP 5xx (it may have been accepted before the
  error surfaced), a timeout/abort, any other network error, an unknown error
  shape, any read failure, or a 5xx/4xx on a legacy witness — is
  `send-failed delivered: 'unknown'`: the item, claim, hold, and witness stay
  reserved. A timeout alone never yields `'no'`, a 404 address read never
  proves non-delivery, and a later-found address or marker always overrides
  the failure classification (`dispatched`).

There is no tick-side retry bookkeeping for consult dispatches — the owner
drives retries, and no dispatch ever re-issues a request for an item that
already carries a witness: the probe showed a same-id re-send can replace a
turn after a staged revert.

`resolveConsult(sessionId, itemId)` is the reconnect-time outcome check for an
item stranded by an ambiguous dispatch (route
`POST .../items/:itemId/resolve-consult`): it never prompts and never clears a
witness. The witness decides what is provable:

| Item state | Answer |
|---|---|
| no witness, unclaimed, not sending | `{ status: 'resumable' }`: no dispatch step ever ran, so no request can exist; the item is stamped `recoverable: true` (same never-sent proof as the post-write cleanup) and committed, so clients may claim or resume. |
| no witness, claimed | `{ status: 'unresolved' }` untouched (the owner is mid-flow). |
| legacy witness, no receipt runId | `{ status: 'unresolved' }` — never `resumable`, never `recoverable`. |
| legacy witness, marker found in the deeper tail (200) | `{ status: 'dispatched', delivered: 'confirmed', evidence: 'legacy-marker' }`; remove exactly once, release the claimed owner's hold (a non-empty owner only). |
| legacy witness, no marker or a failed read | `{ status: 'unresolved' }` untouched. |
| modern witness, address 200 | `{ status: 'dispatched', delivered: 'confirmed', evidence: 'address' }`; same removal/release. |
| modern witness, any other address outcome (404, 400, read failure) | `{ status: 'unresolved' }` untouched with the witness kept. |

The read awaits, so the decision is re-checked against the queue afterwards:
when the item vanished, its attempt id changed, its claim identity changed
(owner and `claimedAt`), or a send started meanwhile, the answer is
`unresolved` and nothing is mutated. The live queue state decides, never the
stale read.

The prompt body is built exactly as `sendItem` builds it, plus a top-level
`system` and the consult metadata attached to the primary text part the way a
context part carries its metadata; it always takes the prompt route. The
metadata carrier must be a text part, and it never overwrites another part's
metadata: the receipt attaches to the first text part only while that part
carries no metadata of its own (the user's text, or a command part); when the
first text part is a captured-context part with its own payload, or the prompt
has no text part at all (attachment-only), one synthetic carrier text part
(`CONSULT_RECEIPT_CARRIER_TEXT`, `[consult receipt]`) is inserted before the
files, so the receipt still lands, the context metadata survives, and runId
correlation stays possible; the UI mirror keeps the same rule.

### Parent-session prompt gate

`hasActiveConsultReservation(sessionId)` is true while the session's queue
holds at least one consult item whose claim owner still has a live hold (the
same lazy-pruning hold read the rest of the runtime uses; items are never
mutated). The OpenCode proxy mounts a fail-open gate on `/api` before the
forwarding handler: a POST to `/session/<id>/prompt_async`, `/message`,
`/prompt`, `/command`, or `/shell` for a reserved session is answered
`409 { error: 'consult-reservation', … }` and never forwarded, so another
OpenChamber surface (or a script) cannot start a turn in a session a Consult
Models run owns. Other methods and routes pass through untouched, and a gate
failure logs and fails open. The queue's own dispatch is unaffected: it calls
OpenCode directly through `openCodeFetch` (built from `buildOpenCodeUrl`), not
through the `/api` proxy.

### Sweep and restart

A consult item never turns back into a normal item: the user's consult intent
survives a lapsed reservation and a server restart. The expiry sweep
(`pruneExpiredHolds`, running on every hold mutation and from the
tick/snapshot read paths) clears a lapsed claim: `claimed` and the stale
synthesis `consult.system` are dropped, `kind: 'consult'` stays, and the
cleared claim is committed and broadcast. The receipt metadata
(`consult.textPartMetadata`) survives: it is the acting run's
delivery-correlation identity, so a later resolve can re-check whether that
turn already landed before a resume re-fans-out, and the payload stays bounded
because the metadata was capped when it was parsed. The dispatch witness
(`consult.attempt`) survives a lapse and a restart too; only `claimed` and the
stale synthesis drop. The item keeps its message content (text, attachments,
context, sendConfig, contextPreview) and keeps blocking the queue, because the
generic dispatcher still refuses to send it. Holds are memory-only, so on
startup every persisted consult item is restored unclaimed (stale `claimed`
and `consult.system` dropped, kind, receipt metadata, and witness kept) and is
likewise never tick-delivered. A version-1 file restores every consult item
with a legacy witness (`{ legacy: true, at: createdAt }`): the old build
persisted payloads fire-and-forget, so "no attempt recorded" there is not
proof that none was made. A stuck consult item is removed only by an explicit
user action (`remove`/`clear`) or a guarded run's own
`remove-consult` (below); `take` refuses consult items with a 409
`consult-item` reason and `takeAll` skips them, so a raw-send client can never
lose the consult intent. This is the no-raw-delivery guarantee: a consult
message is either dispatched through its own route or deleted by the user.

### Conditional consult remove (`remove-consult`)

A run that once held a claim must not delete a consult item unguarded: a lost
claim is not a proof of non-delivery, and a witnessed item's removal would
destroy the reconciliation evidence another client's resolve needs
(invariant I13). `removeConsult(sessionId, itemId, { owner, attemptId? })`
route `POST .../items/:id/remove-consult`) removes only when the server
confirms, at removal time, that the requesting owner still holds exactly this
reservation and no foreign attempt witness stands. Guard order: `sending` →
`not-found` → `not-consult` → owner → witness. The only witness-bearing
removal is the same-owner/same-`attemptId` exception (the dispatcher's own
prep-phase unwind). A legacy witness has no addressable id, so it is always
refused — "unknown" is not a proof of never-sent — and a modern witness
matches only a defined `attemptId`. Every refusal answers `200 { removed: false, reason:
'sending' | 'not-found' | 'not-consult' | 'not-owner' | 'witnessed' }` with
zero mutation — no removal, no commit, no revision bump, no broadcast; success
removes, releases the claim owner's hold, and commits exactly like `remove`,
and a repeat call answers `not-found` idempotently. The legacy
`DELETE .../items/:id` (owner-less) path is unchanged for manual removals and
normal items.

### Recovery (`recoverable`)

A consult item whose reservation is gone and which carries no dispatch
witness — the hold lapsed, or a restart stripped the claim (a reservation
never survives a restart) — becomes `recoverable: true` (set in the same sweep
that clears the claim, on restore in `load()` when the witness is absent, and
by resolve's resumable branch on the same never-sent proof).
The marker is consult-only and rides snapshots, broadcasts, and persistence
like the other item fields; it is a hint for clients, not a behavior switch:
the item keeps blocking the head exactly as before and is never raw-sent. A
client may resume the consult by claiming the recoverable head item through
the existing claim route (the marker is cleared on the claim) or the user may
remove it.

A witnessed item never carries `recoverable` **while the witness stands**: the
witness means a request may already exist for it, so a resume could duplicate a
turn the user paid for. Its only exits are a resolve that proves delivery
(address 200 or the legacy marker) or manual removal; the client's safe action
there is removal. One dispatch-side cleanup also returns an item to
`recoverable`: when dispatch deletes its own witness because the claim was lost
during the awaited witness write (nothing was sent), it stamps `recoverable`
iff the item ends unclaimed and unwitnessed, so the Resume affordance appears
without waiting for a restart. A version-1 item restored with a legacy witness
is in the same position as a witnessed one: no resume, delivered only if its
receipt marker is still in the transcript, and otherwise unknown until the user
removes it. The kept receipt metadata is what makes a legacy check possible; a
modern witness uses its own message id instead.

## Routes (`/api/message-queue`)

Normal authenticated OpenChamber runtime routes; never on browser URL-token
allowlists.

| Route | Purpose |
|---|---|
| `GET /api/message-queue` | Full snapshot `{ revision, sessions[] }` |
| `POST .../sessions/:id/items` | Append `{ directory, item }`; returns `{ revision, session, itemId }` and arms a dispatch (the session may already be idle) |
| `DELETE .../sessions/:id/items/:itemId` | Remove; `409` while that item is in flight |
| `POST .../sessions/:id/items/:itemId/take` | Remove and return the full item (payloads included); `404`/`409` (consult items refuse with `consult-item`) |
| `POST .../sessions/:id/take` | Remove and return every normal item not in flight, in order (consult items are skipped) |
| `PUT .../sessions/:id/order` | `{ itemIds }` must be a complete permutation |
| `POST .../sessions/:id/items/:itemId/remove-consult` | Ownership-safe conditional remove: `200 { removed: true }`, or `{ removed: false, reason: 'sending' | 'not-found' | 'not-consult' | 'not-owner' | 'witnessed' }` with zero mutation; success removes, releases the claim owner's hold, and commits like the legacy remove. Never sends a prompt. |
| `DELETE .../sessions/:id` | Clear; the in-flight item stays |
| `PUT .../sessions/:id/hold` | `{ held, ttlMs?, owner? }`; per-owner TTL, held while any owner is live |
| `POST .../sessions/:id/items/:itemId/claim` | `{ owner?, ttlMs? }`; reserve the head consult item; `409` reasons: `not found`, `not-consult`, `not-head`, `sending`, `attempt-recorded`, `already-claimed`, `not-idle` |
| `POST .../sessions/:id/items/:itemId/payload` | `{ owner?, consult }`; merge the claimed item's consult payload (a client-supplied `attempt` is stripped); `409`: `not found`/`not-consult`/`not-claiming`/`sending`, `400` on size violations |
| `POST .../sessions/:id/items/:itemId/dispatch-consult` | `{ owner? }`; dispatch the claimed consult item on its dedicated route; always `200` with a structured outcome (`dispatched`/`busy`/`claim-lost`/`not-found`/`not-consult`/`attempt-present`/`attempt-write-failed`/`sending`/`send-failed`), `400`/`500` only for malformed/unexpected errors |
| `POST .../sessions/:id/items/:itemId/resolve-consult` | Reconnect-time outcome check for a stranded consult item; always `200` with a structured outcome (`dispatched` with `delivered: 'confirmed'` and an `evidence`, `resumable` (no witness, unclaimed, not sending: stamps the item `recoverable` and commits; clients may claim or resume), `unresolved`, `not-found`/`not-consult`/`sending`), `400`/`500` only for malformed/unexpected errors; never sends a prompt and never clears a witness |

Every mutation broadcasts `openchamber:message-queue.updated` with
`{ revision, session }` to all connected clients (SSE and WS), so several
devices on one server see one queue. SSE uses the shared control stream at
`/api/openchamber/events`; `/api/global/event` carries no OpenChamber events.
The UI subscribes independently of its OpenCode transport and re-reads the
snapshot whenever either stream reconnects. The session in that payload always names
its `directory`, including the broadcast that removes the last item: the UI
keys its projection by directory, and a broadcast without one left the
delivered message on screen (a session's directory is remembered until the
session is deleted or evicted).

Limits: 20 items per session, 50 sessions (oldest evicted, never one with an
item in flight, a live hold, or any `kind: 'consult'` item; when no session is
safely evictable, an enqueue that would create a new session is refused with a
`409` and existing queues are left unchanged), 200k characters of content;
attachment payloads are bounded
by the route family's 50 MB JSON limit. When a session's queue is full, a new
enqueue evicts the oldest **normal** item, never a consult item; if every
slot holds a pending consultation the enqueue is refused with a `409`
instead of silently dropping one.

## UI ownership

`packages/ui/src/stores/messageQueueStore.ts` is the projection: see its
section in `packages/ui/src/stores/DOCUMENTATION.md`. VS Code intentionally
does not use this module; with all OpenChamber webviews closed, queued
messages there are not delivered.
