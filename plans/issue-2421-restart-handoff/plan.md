# Issue #2421: Restart Handoff

## Accepted architecture

- Keep phase-1 v1 in `managed-opencode-handoff-protocol.js` unchanged.
- Add an isolated v2 namespace under `packages/web/server/lib/opencode/managed-opencode-handoff-v2/` for Linux/POSIX Web-daemon foundations.
- V2 owns a private local master-secret provider, a separate SQLite record store, and a signed reservation/lease protocol. It does not share the legacy managed-process registry or any auth/HMR/CLI secret source.
- Default v2 storage is `~/.local/state/openchamber/managed-opencode-handoff-v2/`, containing `master-secret.bin` and `master-secret.initialized` (`0600`) plus `records.sqlite3`; records contain public identity, lease, revision, and MAC fields only.

## Phase order

1. **Phase 1 — complete:** isolated v1 protocol and fake-store tests.
2. **Phase 2A — current:** v2 secret provider, SQLite CAS store, reservation/launch/lease protocol, tests, and owning documentation.
3. **Phase 2B — later:** Linux guardian and verified process-identity/recovery design.
4. **Phase 3 — later:** Web lifecycle, startup, shutdown, and CLI wiring after guardian review.
5. **Phase 4 — later:** separately approved Electron, VS Code, UI, and session-resume work.

## Current status

**Second Phase 2A remediation implementation is complete locally and awaits native-review disposition.** The new delivery fence, schema/metadata checks, secret-only-root rejection, OS-process initialization coverage, and end-to-end secret-provider fsync coverage address the second review. Phase 2B remains blocked; no lifecycle, guardian, startup/shutdown/CLI, route, Electron, VS Code, UI, handoff/adoption, or session-resume wiring is included here.

## Phase 2A state machine

`reserved -> launch-delivering -> launching -> active -> handoff-prepared -> claimed -> active`

- Phase 2A implements only `reserved -> launch-delivering -> launching -> active`, active lease renewal, and explicit interruption/stopping/retirement handling. The short-lived `launch-delivering` fence permits only its owner to complete delivery; public terminal mutations cannot win during that fence.
- `reserved`, `launching`, and `active` may become `interrupted` or `stopping` on an explicit failure path.
- `handoff-prepared` and `claimed` are reserved future states; no handoff or adoption operation is exposed in Phase 2A.
- `stopping -> retired`; `interrupted` and `retired` have no outgoing Phase 2A transitions.

## Risks and gates

- Secret, filesystem, SQLite, clock, MAC, or CAS failure blocks v2; it is never treated as an absent/free record.
- Credential material is armed before `reserved -> launch-delivering` CAS. A terminal mutation either wins before that fence (so delivery cannot begin) or is rejected while delivery is fenced; expiry and callback failure revoke material before user callback delivery.
- Renewal is bounded from authoritative store time, never accumulated from a prior expiry.
- Master initialization has durable evidence and exclusive creation semantics; a missing/corrupt secret in a previously initialized root, or a secret-only root without evidence, fails closed. Deleting the whole root remains an unavoidable loss-of-evidence boundary.
- Concurrent store initialization must converge under SQLite locking/retry across worker threads and OS processes, and reject damaged, under-constrained, metadata-tampered, or SQLite-lookalike schema objects.
- No raw master, child credential, or lifecycle material may be persisted, logged, returned as public record data, or reused from existing auth/config state.
- Validate focused unit/integration tests, source syntax, package checks available in the worktree, and documentation consistency. No real child, ports, signals, lifecycle, registry, route, CLI, Electron, VS Code, UI, or resume wiring belongs to this package.
