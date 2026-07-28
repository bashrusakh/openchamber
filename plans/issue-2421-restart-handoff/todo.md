# Issue #2421 Todo

## Phase 2A — V2 Durable Foundation (COMPLETE)
- [x] All remediation rounds and third review approved.
- [x] 27 v2 tests pass, 19 v1 tests pass, type-check, lint, docs, syntax clean.

## Phase 2B — Linux Guardian Process (COMPLETE)
- [x] Design guardian architecture and IPC protocol
- [x] Implement guardian core module (spawn, stop, health, lease renewal, cleanup)
- [x] Implement IPC server (Unix socket, JSON line protocol)
- [x] Implement guardian client (web server side)
- [x] Implement entrypoint/CLI (`openchamber guardian` command)
- [x] Tests: 19 focused unit tests for guardian core and IPC
- [x] Security review: 6 findings identified and remediated
  - [x] P0/Critical: Fix adopt fingerprint algorithm mismatch (HMAC vs SHA-256)
  - [x] P1/High: Terminate orphaned child processes when spawn fails after creation
  - [x] P2/Medium: Restrict Unix socket permissions atomically (umask)
  - [x] P2/Medium: Replace PID file with atomic create (O_EXCL)
  - [x] P3/Low: Ensure stopChild deletes from #children even if retire fails
  - [x] Question: Confirm credential zeroing after withCredential
- [x] Re-review after remediation: **APPROVED for Phase 3**
- [x] Validation: 65 tests, type-check, lint, docs all clean

## Phase 3 — Lifecycle Integration (PENDING user approval)
- Integrate guardian with `bootstrapOpenCodeAtStartup()` (detect guardian, adopt children)
- Integrate guardian with `restartOpenCode()` (request handoff preparation)
- CLI `restart --handoff` command wiring
- Full validation and integration tests

## Phase 4+ (BLOCKED pending Phase 3)
- VS Code/Electron/mobile integration
- Session resume and agent loop restoration
- Cross-runtime handoff
