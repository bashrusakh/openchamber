# Git execution architecture

## Objective

Port the bounded, worktree-aware Git execution model into the current mainline without changing public Git response shapes or runtime-specific adapters.

## Scope

- Shared web Git context resolution, operation classification, scheduling, status coalescing, clone reservations, cancellation, and structured errors.
- Web Git service integration at the operation boundary, while preserving current worktree bootstrap, lock recovery, long-path, nested-repository, and neutral-CWD behavior.
- VS Code integration through source-bundled shared modules, with built-in Git API preference and raw Git fallback retained.
- Focused tests and package validation only; no dependency, API, changelog, or publication changes.

## Invariants

- Repository identity is derived from Git, not directory heuristics.
- Worktree-scoped work may proceed concurrently across unrelated worktrees; common and topology mutations are barriers within one repository.
- A queued writer cannot be starved by later compatible reads.
- Cancellation and queue timeout remove only the waiting caller; shared status work remains alive for other waiters.
- Falsy rejection reasons are preserved and all admission state is released on every completion path.
- Diagnostics do not mutate scheduler state, and idle state remains bounded.

## Current phase

Verification: shared primitives and adapters are implemented; the isolated VS Code suite passes 30/30 files, focused VS Code regressions pass, and the web coordinator, resolver, and execution-service tests pass under Bun. The repository's Vitest, type-check, and lint environment remains incomplete.
