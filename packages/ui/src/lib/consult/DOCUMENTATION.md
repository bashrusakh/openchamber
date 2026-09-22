# Consult Models advisor runtime

## Authority

`lib/consult` owns the temporary advisor forks of a Consult Models run. The
module set is:

- `metadata.ts` (WP1.1) owns the `openchamber.kind = 'consult-advisor'` marker
  contract. Every read decodes persisted metadata through its zod schemas. The
  read contract is `kind` + `consultRunID` — the same two fields the
  notification server suppresses on — so a partial marker hides, is
  GC-eligible, and is push-silent identically everywhere. The parent id and
  the advisor index ride along when present.
- `routing.ts` owns two pure decisions: where a fork branches off the parent
  transcript, and whether the selected advisors exist on the runtime.
- `prompts.ts` owns the turn-scoped framing text sent as the advisor `system`.
- `completion.ts` owns the per-advisor completion wait.
- `runtime.ts` owns the fork lifecycle and is the only module that talks to the
  SDK for a consultation. It exposes `consultRuntime` (the live instance) and
  `createConsultRuntime(deps)` for tests. It also owns the active-run registry
  (`isConsultRunActive`) that the GC consults.
- `gc.ts` (WP1.4) owns the stale-fork sweep: it deletes advisor sessions whose
  run is no longer active and whose last activity is older than the threshold
  (default 60 min). `sweepStaleConsultAdvisorForks()` is the live-wired sweep.
- `synthesis.ts` (WP3.2) owns the pure builders: the anonymous untrusted
  synthesis block, the degraded notice, and the bounded per-message receipt
  with its metadata read boundary. The synthesis block is bounded client-side
  by `CONSULT_SYNTHESIS_SYSTEM_CHAR_BUDGET` (23_000), deliberately below the
  message-queue server's `CONSULT_SYSTEM_CHAR_LIMIT` (24_000), so advisor
  output is truncated instead of a payload update being rejected; keep the two
  constants in sync.
- `submission.ts` (WP3.2) owns queue admission and the acting dispatch:
  `createConsultSubmission(deps)` is the injectable seam, and
  `submitConsultMessage(input)` is the live entry point.

`synthesis.ts` and `submission.ts` are the WP3.2 layer: the synthesis block,
the acting dispatch, and queue admission/hold. Parent deletion/archive cleanup
lives in `sync/session-actions.ts`, which discovers advisor forks through the
marker's `originalSessionID`. The hidden-session predicate is
`lib/sessionVisibility.ts` (WP1.2), and the pending-hide registry is
`stores/useConsultPendingHideStore.ts`.

## Runtime contract

`consultRuntime.startConsultation(input)` returns `{ runId, result }`
synchronously. The run id is also the `consultRunID` bound into every fork
marker. `result` resolves to `ConsultationResult`:

- `status`: `ok` when every advisor produced text, `partial` when some did,
  `degraded` when none did, `cancelled` when the run was cancelled or the
  runtime changed.
- `blocks`: anonymous successful outputs in advisor order. The synthesis text
  must not attribute them to models.
- `advisors`: per-advisor provenance (`providerID`, `modelID`, `variant`,
  `agent`, `status`, `durationMs`, optional `reason`) for the receipt.

A degraded result is still a valid result: the caller dispatches the acting
turn with the explicit no-usable-output notice. A cancelled result is not
dispatchable. Start refusals reject `result` with `ConsultationRefusedError` and
carry a `code` (`no-advisors`, `runtime-changed`, `surface-unavailable`,
`invalid-advisor`, `no-settled-context`); `invalid-advisor` also carries the
per-advisor `rejections`, which the composer renders as one localized toast
line per rejected advisor (`formatConsultRejections`); the dialog is already
closed when a refusal settles.

The pre-enqueue prevalidation (`prevalidateConsultation`, called by the
submission before any hold or queue item exists) checks the advisor surface
only: runtime key, non-empty advisor list, and
`validateConsultAdvisors` over the loaded provider/agent catalog. It
deliberately does **not** resolve the settled fork point, so a parent whose
turn is still running is not refused pre-enqueue: 'no-settled-context' is a
start-time refusal raised inside `startConsultation` after the claim, where
the submission's post-claim contract (remove the consult item, release the
hold, return the message to the composer) applies.

## What is stored where (retention contract, F4)

- Advisor fork transcripts exist for the fan-out and are deleted after
  collection (run cleanup, stale-fork GC, parent delete/archive); they are not
  retained.
- Successful advisor texts are copied into the acting turn's synthesis
  `system`, which OpenCode stores on the acting user message
  (`UserMessage.system`). That field is active for the acting turn only — the
  next ordinary turn does not re-apply it (Phase 0 verified) — but it is
  persisted with the parent session and is visible in its API/export/share
  surface. The ordinary chat UI does not render it as message content.
- The receipt is persisted as bounded text-part metadata on the acting user
  message and rides the session's data the same way. An attachment-only
  consult message carries no receipt: OpenCode's file parts have no metadata
  field, so the metadata is only ever attached to a text part (the server
  bound is documented in the message-queue module).
- Advisor identities are not part of the synthesis text or the receipt's
  blocks; provenance stays in the run store and the receipt's advisor rows.

`consultRuntime.cancel(runId)` is idempotent. It records cancellation first
(synchronously, before any await), then releases this run's owner-scoped queue
admission hold (`consult:<runId>`), then aborts each known fork best-effort,
then deletes each known fork best-effort and releases its pending-hide entry.
Late advisor results are dropped by rechecking the run token and the captured
runtime key before any outcome is applied.

Starting a new consultation for the same parent **supersedes** the previous
run: the previous run's cancellation is recorded and its forks are aborted and
deleted before the new run forks anything. Only one live run per parent exists
at any time; a run registers its id in the shared active-run registry for its
whole lifetime.

The admission hold is released on cancellation through the injected
`releaseAdmissionHold` hook (default:
`useMessageQueueStore.getState().setServerHold(sessionId, false, consultHoldOwner(runId))`).
The normal settle path deliberately does **not** release: the submission that
asserted the hold keeps it valid through its own dispatch and owns that
release, so releasing at fan-out end would open a gap before the acting turn
is sent. The release is per-run idempotent, fire-and-forget, and swallows
failure so it can never throw into the settle path. Because holds are
owner-scoped per run, a superseded run's release can only clear its own
`consult:<runId>` slot and never the superseding run's hold; the server keeps
one TTL per `(sessionId, owner)` and holds the session while any owner is
live, so the owner-less auto-review hold is independent too (see the
message-queue documentation). A run whose captured runtime is no longer active
skips the release: a hold belongs to the server that created it, and session
ids are not unique across runtimes.

`startConsultation` dispatches every advisor with `trackProviderErrors: false`
(WP1.6), so failing advisors never open the shared provider circuit for the
acting turn.

## Advisor lifecycle

1. `startConsultation` captures the runtime key and returns the handle. The
   caller must already hold queue admission (WP3.2) and may pass
   `assertAdmissible`; this module does not implement queue logic.
2. `executeRun` refuses an empty advisor list and a stale runtime key, then
   loads the model surface through `opencodeClient.getProvidersForConfig` and
   `opencodeClient.listAgents`. A surface that cannot be loaded refuses the
   start instead of forking unvalidated.
3. `validateConsultAdvisors` checks every provider, model, variant, and agent
   before the first fork. The pinned server returns `204` for an unknown model
   or agent and only later emits `session.error`, and it silently drops an
   unknown variant (Phase 0 A5), so client-side validation is the only place
   the "exact selection, no substitution" contract can be enforced.
4. `resolveConsultForkPoint` reads the parent transcript through
   `getSyncMessages` (injectable as `readParentMessages`) and forks at HEAD
   when the parent's trailing message is not an unfinished assistant reply.
   When it is, the fork anchors at the last completed assistant message
   instead, and a parent with no completed assistant message refuses with
   `no-settled-context`.
5. Per advisor, in order: `forkSession` → `pendingHide.register(forkId)` →
   `patchSessionMetadata` with `withConsultAdvisorMarker` as the first write
   after the fork → `pendingHide.release(forkId)` → `registerSessionDirectory`
   → `updateSession({ permission: CONSULT_ADVISOR_PERMISSION })`. The wildcard
   deny-all ruleset removes the tool schema from the advisor request entirely
   (Phase 0 A3/A4/A9), so advisors cannot mutate files, run commands, ask
   questions, or start sub-agents. **The written ruleset is verified by
   read-back** (the `updateSession` echo, or one `getSession` refetch when the
   echo omits `permission`): the effective ruleset must carry the exact
   `*`/`*`/`deny` rule. A failed verification fails that advisor with
   `permission-verification-failed` — the fork is deleted and the advisor is
   never sent to — while the run continues with the remaining advisors. A
   failed read-back request fails closed instead of sending unverified.
6. A `forkSession` rejection is ambiguous: the server may have created the
   clone before the response was lost. The run never tries to recover, hide,
   mark, or delete such a clone. This is an intentional architectural
   boundary, not an accepted limitation: reconciliation without guessing is
   impossible. The SDK fork contract (`SessionForkData`) carries only
   `messageID` — no idempotency key and no client-supplied metadata; a clone
   carries no `parentID` and copies the parent's title and metadata
   wholesale; the sessions list has no created-after filter (only a
   `time.updated` cursor); and the consult marker is written only after
   `forkSession` resolves, so in exactly the lost-response case it cannot
   exist yet. Every remaining correlation signal (timing, title, transcript
   prefix) is shared with legitimate user sessions and with parallel sibling
   forks, so "a session id that appeared after a listing" is not positive
   identification, and mutating the wrong session is worse than leaving the
   clone; the advisor is reported failed with the fork error instead.
   Intentional bound (v1): a fork whose creation response is lost may remain
   as a visible, unmarked session that the user can delete manually. The GC
   already deletes MARKED orphans (a session whose marker lost its `kind` or
   `consultRunID` is never a deletion candidate), so an unmarked clone is
   invisible to the sweep and stays visible until manual deletion. A future
   fix requires an upstream fork contract change: an idempotency key or
   client-supplied metadata on fork creation.
7. The advisor prompt is sent headlessly through `opencodeClient.sendMessage`
   with the exact provider, model, variant, and agent, the parent message text,
    its attachments, the same captured context parts the acting turn receives
    (instructions as synthetic parts, context parts with their metadata, and
    synthetic parts — `queuedContextToParts(takenItem.context)` computed by the
    submission, behind the standing-knowledge prefix part), and
    `CONSULT_ADVISOR_SYSTEM_PROMPT` as `system`. The send bypasses
    `useSessionUIStore.sendMessage` and `routeMessage`, so the parent's
    composer, selection stores, and queue state are never touched.

   Advisor-vs-acting input differences, recorded explicitly:

   - context parts and attachments: identical to the acting turn (REQ-4);
   - standing session knowledge: the submission resolves the parent's pending
     knowledge once per run (the `fetchSessionKnowledge` submission dep) and
     prepends it to the advisors' parts as one synthetic
     `systemContext: 'session-knowledge'` part, before the captured context —
     the same prefix a UI send prepends, so advisors see the same standing
     context the acting turn sees. This is read-only parity: the advisor flow
     never records delivery (`recordDelivered` stays with the acting
     dispatch, which resolves the pending knowledge again server-side);
     a failed fetch is fail-open — advisors are sent without the block;
   - command/skill expansion: unreachable for consult — slash-command composer
     input is refused before a consult starts, so advisors never need the
     command-route template expansion the acting dispatch may perform.
8. `waitForConsultAdvisorCompletion` reads the fork transcript tail until the
   trailing assistant message after the sent user message has
   `time.completed`. Visible non-empty text is a success; a completed message
   with no visible text is `empty`; an assistant `error` is a failure; the
   per-advisor deadline (default 120 s) is a timeout. A transcript read failure
   is unknown, not empty: the read is retried until the deadline.
9. Fan-out is parallel with a ceiling of three forks, or strictly one at a
   time in `sequential` mode. Advisors never see each other's output.
10. After collection every fork is deleted best-effort and every pending-hide
    entry the run registered is released, including forks whose marker never
    landed. A failed delete leaves the fork hidden by its marker; the GC owns
    the leftover.
11. The result is built from the collected outcomes and returned; the settle
    path does not release the admission hold (the submission owns that
    release).

## Submission contract (`submission.ts`, WP3.2)

`submitConsultMessage(input)` is the single entry point for a Consult Models
run. It takes the parent session, its directory, the captured runtime key, the
message exactly as the composer queue captures it (`content`, `text`,
`agentMentionName`, attachments, context parts), the acting send config
(provider/model/agent/variant), the exact advisor selections, the mode, and the
per-advisor `timeoutMs`. It returns `{ runId, result, cancel }` synchronously.

`result` settles with one of five states; only `dispatched` means the acting
turn was sent:

- `dispatched` — receipt + consultation result;
- `cancelled` — cancelled before dispatch;
- `refused` — a start refusal (`code`, `rejections`);
- `failed` — any other pre-dispatch failure;
- `delivered-raw` — the item left the server queue without this submission
  claiming and dispatching it (another client removed it, for example). A
  consult item is never delivered as a normal send, so the caller must not
  restore the composer and must not re-send, and should tell the user the
  consultation did not happen. `queueItemRestored` is `false`. The composer
  branch implements this as `consultCaptureDisposition` (keep the capture
  cleared) plus the localized delivered-raw toast.

`queueItemRestored` on `refused`/`failed` is `true` only for the
enqueue-rejection and unattributable-append edges (a copy of the message is
still queued and will be delivered normally, so the caller must not also
restore the composer). On the post-claim refusal/failure paths it is `false`
and the caller restores the composer from its own captured payload. `cancel()`
is idempotent and unavailable once the acting turn is being dispatched; the
caller restores the composer on `cancelled`.

The lifecycle:

1. The run store starts at `waiting-admission`.
2. Prevalidation (F2) runs BEFORE any hold or queue item exists: the advisor
   surface and the parent's settled context are checked exactly as
   `startConsultation` would check them, without creating a fork. An ordinary
   start refusal happens here — nothing is queued, nothing is held, and the
   caller restores the composer from its own captured payload.
3. The owner-scoped hold (`consult:<runId>`) is acquired and **awaited before
   the item exists**, so the server's 500 ms dispatch quiet timer can never
   race the hold round trip; the heartbeat starts immediately after. The
   server re-checks the hold after its own idleness awaits, so a hold landing
   mid-tick still stops that send. If the hold fails, nothing is enqueued and
   the submission fails.
4. The message is enqueued with `useMessageQueueStore.addToQueue` in the
   composer's capture shape, marked `kind: 'consult'` — the generic
   dispatcher never delivers it.
5. The submission watches the queue projection and the directory status until
   its item is the queue head **and** `resolveQueuedSessionStatusType` reports
   `idle` (the same gate the queue's own auto-send uses). Cancellation (the
   handle, or a store phase of `cancelled`), a superseding run, a runtime
   change, and the item leaving the queue all stop the watcher before the
   claim. The hold is re-asserted every `CONSULT_HOLD_REASSERT_MS` (2 min, well
   inside the server's 5 min TTL) while the item waits, so a long admission
   wait cannot let it expire.
6. The consult item is claimed for this run's owner
   (`claimConsultItem`): the item is reserved, the generic dispatcher is kept
   away by the claim's hold, and re-polling tolerates a busy/not-head refusal.
   A claim failure releases the hold and fails the submission (the item stays
   queued until the server's expiry sweep reverts it). An item that vanished
   is `delivered-raw`.
7. The store moves to `consulting` and `consultRuntime.startConsultation` runs
   with `runId` (the store's run id) and `expectedRuntimeKey`.
8. The hold is re-asserted once more for the fan-out (the heartbeat keeps
   beating); the owner scoping means no other feature's or run's release can
   clear it.
9. On a non-cancelled result the store moves through `settling` and
   `dispatching`; the synthesis `system` and the receipt `textPartMetadata`
   are merged onto the claimed item via `setConsultItemPayload`, and the item
   is dispatched through its own route (`dispatchConsultItem`) — the server
   verifies the claim, waits for idleness, sends the item with its payload,
   removes it, and releases this owner's hold. The submission does not release
   the hold again after a successful dispatch.
10. `done` is recorded with the per-advisor outcomes and the degraded flag.
   Every terminal path releases the hold exactly once — except the successful
   dispatch, where the server already released it and the submission suppresses
   its own release. Hold operations are serialized per run: every re-assert
   chains behind the previous one, and the terminal path marks the run
   inactive, awaits the in-flight hold operation, and issues the release last,
   so a stale re-assert can never land after the release and resurrect the
   hold (queue stalls until the TTL).

Branches:

- partial success dispatches with the successful blocks only; the receipt
  records the failed rows and their reasons;
- all advisors failed dispatches the explicit degraded notice
  (`buildDegradedConsultNotice`) and a `degraded` receipt — degraded after a
  real start still dispatches alone, never as a normal queue delivery;
- a cancelled consultation or a cancel before dispatch never dispatches; the
  claimed item is removed so it can never be delivered as a normal send;
- a refusal or non-degraded failure AFTER the claim removes the consult item
  and releases the hold — the message is never re-queued for normal delivery
  (F2); `queueItemRestored` stays `false` and the caller restores the composer;
- an enqueue rejection fails the submission and the caller restores its
  capture; if the server accepted the item before the rejection, that queued
  copy is delivered normally later (accepted v1 bound, see "Accepted v1
  limitations");
- the item leaving the queue before the claim — or a claim that cannot find
  the item — is `delivered-raw`: never restore, never re-send;
- a concurrent append that cannot be attributed to this submission is never
  claimed; the submission fails with `queueItemRestored: true` so the caller
  does not duplicate a message that is still queued;
- a runtime change at any point stops the heartbeat and skips queue and hold
  operations entirely: both belong to the runtime that created them, and
  session ids are not unique across runtimes. An already-claimed item is not
  removed across the change (the claim belongs to the old runtime's owner and
  lapses into the server's sweep); the composer restores (accepted v1 bound,
  see "Accepted v1 limitations");
- the hold release is idempotent per submission on every path, and a
  superseded submission releases only its own `consult:<runId>` owner — the
  superseding run's hold is untouched because it is a different owner.

**Honest hole (plan D5).** If the UI disappears mid-consult, the heartbeat
dies with it and the hold expires server-side. The item keeps
`kind: 'consult'` and its claim simply lapses, so the generic dispatcher never
delivers it as a normal send: it stays at its session's queue head and blocks
that queue until a live run resolves it through its own dispatch route or the
user removes it manually. The submission detects the item leaving the queue
without this run (`delivered-raw`) instead of reporting a cancel that would
restore the composer and duplicate the send.

**Resume (#3743).** A stranded consult item the server marked `recoverable`
(reservation lapsed with the submitting client) is re-claimable from the queue
chip's Resume affordance: `resumeConsultItem(target, item, runOptions)` claims
the existing item (never enqueueing, never sending raw) and re-runs the
consultation through the same claim → fan-out → payload → dispatch route as a
new submission, with fresh advisor options from the caller.

**Reconnect resolution (#3743).** On every queue hydration the store scans
dangling consult items (`claimed` or `recoverable`) and posts one outcome
check per item to the server's never-prompting resolve route, guarded
in-flight per item; `dispatched` removes the chip through the server's own
broadcast, `unresolved` keeps it (Resume when `recoverable`), and a failed
check is swallowed so hydration never breaks.

**VS Code.** `setServerHold` is a no-op where the queue is not server-owned,
and the local `useQueuedMessageAutoSend` hook can deliver the item before the
submission takes it. `capability.ts#resolveConsultMechanismCapability` reports
the runtime as `unsupported-runtime` there; the composer surface gates on it
(see "Runtime coverage and open gaps").

## Stale-fork GC (`gc.ts`)

The advisor runtime deletes its forks after every run, but a fork can survive a
failed delete, a lost page, or a crash between the fork call and the marker
write. `sweepStaleAdvisorForks(deps)` deletes a fork only when all three hold:

1. its marker parses as `kind: 'consult-advisor'` **plus** a non-empty
   `consultRunID` (the marker schema is the read boundary and the same
   contract the notification server suppresses on; a marker missing either is
   never a deletion candidate);
2. its `consultRunID` is not in the active-run registry (`isConsultRunActive`),
   so a live run's forks are never touched even if the clock says they are old;
3. its last activity is older than the threshold (default 60 min).

The sweep stops as soon as the runtime changes and reports
`skippedReason: 'runtime-changed'`; the captured runtime key is also passed to
`deleteSessionInDirectory`, which enforces the same guard. One failed delete is
reported in `failedIds` and never blocks the other candidates. A deleted fork's
pending-hide entry is released.

The zero-argument `sweepStaleConsultAdvisorForks()` is the live wiring over the
global session cache, `deleteSessionInDirectory`, the shared run registry, and
the pending-hide store.

## Parent deletion and archive

`sync/session-actions.ts` deletes a parent's advisor forks as part of its own
delete/archive cleanup. Advisor forks carry no `parentID`, so the server
cascade cannot reach them; they are discovered through the marker's
`originalSessionID` in the sessions this client holds. The fork deletes are
best-effort: a failure is logged and never blocks the parent's operation, and
the leftover is collected by the GC. A session that is itself an advisor fork
does not cascade to its siblings. A partial marker that lost its
`originalSessionID` is still hidden and collected by the GC (which keys on
`kind` + `consultRunID`), but the parent's delete/archive cannot discover it
through the missing parent id.

The archive batching classifies a parent with advisor forks as an individual
session, because the fork cleanup is UI-owned work on a second session and
cannot travel in the server batch.

## Invariants

- One acting agent. The parent session is never written to by the advisor
  runtime, and no advisor output reaches it through this module (the acting
  turn's stored `system`/receipt metadata is the submission's own send; see
  "What is stored where").
- One live run per parent. A new start supersedes the previous run: its
  cancellation is recorded before the new run forks anything, and its forks are
  aborted and deleted first.
- One turn per advisor. There is no follow-up send, no recursive consultation,
  and no output passed between advisors.
- Read-only. The wildcard deny-all session permission is the enforcement, not a
  prompt instruction.
- No silent substitution. A rejected selection refuses the whole start; a
  failing advisor is reported with its status and reason.
- Ambiguous fork failures are never recovered by guessing. The runtime only
  ever touches session ids it received from `forkSession`; a possible clone
  left by a lost fork response is never listed for, hidden, marked, or
  deleted, so it cannot corrupt or remove an unrelated session.
- Failure is not empty. A read error keeps the outcome unknown; only a
  completed message with no visible text is `empty`.
- Cancellation and runtime switches win over in-flight work. The run token and
  runtime key are rechecked after every await that could apply a result.
- The admission hold is owner-scoped per run (`consult:<runId>`), acquired
  and awaited before the item is enqueued, re-asserted by the submission's
  heartbeat for the whole wait/fan-out/dispatch, and released by the
  submission on every terminal path (dispatch, cancel, refusal, failure). Hold
  operations are serialized and the release is issued last, so a stale
  re-assert can never land after it. The server holds a session while any
  owner has a live TTL, so releasing one owner never clears another's. The
  runtime's cancel release is idempotent, never throws into the settle path,
  and is skipped on a runtime that no longer matches the run; a superseded run
  can only clear its own owner slot.
- Advisor sends never participate in the shared provider circuit breaker.
- The consult message is never delivered raw by the submission: the item is
  held before admission, claimed before dispatch, and sent through its own
  dispatch route only after a non-cancelled consultation result. A cancel
  before dispatch never sends; a post-claim refusal removes the consult item
  and the caller restores the composer from its own captured payload, never by
  re-queueing the message for normal delivery. If the item leaves the queue
  without the claim anyway, the submission reports `delivered-raw` and never
  restores or re-sends.
- The submission performs no queue or hold operation after its captured
  runtime key changes; those resources belong to the runtime that created them.

## Runtime coverage and open gaps

The runtime is shared UI code. It runs on web, Electron, VS Code, hosted mobile,
and Capacitor wherever the OpenChamber-managed OpenCode server is the backend.

The composer action is gated by `useConsultLiveCapability` /
`resolveConsultLiveCapability`, which requires two independent proofs:

- the connected OpenCode server reports a version at or above
  `CONSULT_MIN_OPENCODE_VERSION`;
- the connected OpenChamber backend reports `consultProtocol` at or above
  `CONSULT_BACKEND_PROTOCOL_VERSION` on `GET /api/opencode/version`. This is
  the backend half of the handshake: a backend that predates the field ignores
  the unknown consult item `kind` and would deliver the message as a normal
  queued item, so absence must refuse rather than assume support.

The composer's `resolveConsultAvailability` consumes that live capability and
disables the action for every refusal; there is no `unverified` availability
path in the composer:

- `unsupported-runtime`: the runtime has no server-owned queue (VS Code);
- `checking-version`: the initial state, and every re-check while a read is in
  flight;
- `version-unknown`: the version read failed or returned an unparseable value;
- `version-unsupported`: a real OpenCode version below the floor;
- `protocol-missing`: `consultProtocol` is absent or malformed — the
  older-backend case above;
- `protocol-unsupported`: a protocol number below the required version.

The submission re-checks the same capability independently in its
`verifyCapability` seam before it acquires any hold or enqueues, so a caller
that bypassed the composer still cannot queue onto an old backend.
`resolveConsultMechanismCapability` remains only as the synchronous runtime
descriptor used before or without a live read; it never claims verification. A
runtime endpoint change resets `useConsultLiveCapability` to
`checking-version` and re-resolves against the new backend. Nothing in the
advisor runtime branches per runtime, and the queue admission model assumes the
server-owned queue; see the submission contract's VS Code and hold-expiry
notes. The independent Phase 1 verdicts and their residuals are recorded in
`plans/consult-models/reviews/phase-1-verification.md`.

The WP2.2/WP2.3 composer surface is wired: `components/chat/consult/*` provides
the footer action (`ConsultActionButton`, rendered by `ComposerFooter`), the
advisor picker (`ConsultModelsDialog`, which calls `submitConsultMessage`), the
progress panel (`ConsultPanel`), and the receipt (`ConsultReceiptBlock`,
rendered by `message/parts/UserTextPart.tsx`). The composer documentation owns
the surface details.

Known gaps left for later work packages:

- The stale-fork sweep is wired: `sweepStaleConsultAdvisorForks()` runs from
  `hooks/useSessionAutoCleanup.ts` whenever cleanup is enabled and the global
  session cache is ready, and re-runs on parent switches, so it covers app
  load and parent visits. It is independent of `autoRun` (embedded chats and
  the settings surface sweep too); the explicit bound is `enabled: false` (a
  hidden embedded chat does not sweep).
- A fork whose marker write fails is deleted without a marker; if it had
  inherited the parent's `btwSessionID` before the marker replaced the metadata,
  the delete's link cleanup can act on that inherited link. This mirrors the
  existing `/btw` failure path and is left for a later change.

Accepted v1 limitations:

- An attachments-only consult message dispatches without a receipt: the carrier
  is the acting user message's primary text part, and
  `lib/opencode/client.ts` attaches `textPartMetadata` only when that text is
  non-empty, so a consult with attachments and no text delivers the turn with
  no receipt.
- VS Code has no server-owned message queue, so the runtime gate refuses before
  any protocol read: `resolveConsultMechanismCapability` and
  `resolveConsultLiveCapability` both report `unsupported-runtime`, and the
  composer disables the action with that reason. The VS Code bridge's own
  version payload does not carry `consultProtocol`; that absence is never
  reached as `protocol-missing` because the runtime check comes first.
- The collapsed mobile composer pill (`MobilePillComposer`) has no footer, so
  it has no consult entry point; the action is reached by expanding the
  composer.
- A claim that already succeeded before a runtime switch cannot be undone: the
  item stays reserved in the old runtime's queue until its claim lapses into
  the server's sweep (kind kept, never delivered raw), and the submission
  performs no queue or hold operation after its captured runtime key changes
  (see the submission contract's branches).
- A runtime switch mid-admission strands the queued item in the old runtime's
  queue while the composer restores. The item and the hold belong to the old
  runtime, whose server keeps the consult item and never delivers it as a
  normal send: once the hold expires the claim and payload are swept and the
  item keeps blocking until it is removed manually. The submission performs no
  queue or hold operation after the switch, and session ids are not unique
  across runtimes, so there is no cross-runtime duplicate guard. Accepted v1
  bound.
- An ambiguous enqueue failure can leave an item delivered while the composer
  restores. If `addToQueue` rejects after the server accepted the item, the
  submission reports `queueItemRestored: false` and the caller restores its
  capture, while the queued copy is delivered normally later. The queue append
  is not idempotent, so this is the same ambiguity every queued send has.
  Accepted v1 bound.
- A fork whose creation response is lost may remain as a visible session: an
  ambiguous fork failure is never recovered by guessing (see the advisor
  lifecycle, step 6), so the clone has no marker and no GC eligibility and
  stays until the user deletes it manually. Accepted v1 bound.
- The cross-client pending-hide exposure window: the registry is in-memory per
  client, so another client can briefly see a fork before its marker is
  readable. Accepted for v1 (plan D11).
