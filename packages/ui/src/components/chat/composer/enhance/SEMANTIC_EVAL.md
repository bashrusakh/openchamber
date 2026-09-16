# Semantic eval cases — Enhance Prompt

Manual semantic evaluation of the `composer.enhance.instructions` contract
(the magic prompt behind the composer's Enhance Prompt action).

**How to run:** set the Small Model in Settings, then either paste a case
below as a composer draft and click **Enhance Prompt**, or call
`enhancePrompt` (packages/ui/src/components/chat/composer/enhance/
promptEnhancer.ts) directly with the case as the draft. Compare the result
against the expectations below.

These are **not** deterministic CI tests: LLM output is stochastic and exact
wording is never asserted. Judge each result only against the semantic
expectations.

| Input | Semantic expectations | Must-not |
| --- | --- | --- |
| `analyze issue 3366` | Target `issue 3366` kept as-is. Understand-oriented: inspect the issue, weigh evidence, return an assessment. More actionable than punctuation-only rewrite (states what an analysis should produce). Uncertainty about the issue's content stays open. | No invented issue content, status, or cause. No implementation. Reference not resolved from own knowledge. |
| `fix issue 3366` | Target `issue 3366` kept as-is. Change-oriented: understand the problem first, then fix, then verify the outcome. The issue reference stays unresolved. | No invented root cause, files, or fix mechanism. No invented issue contents. |
| `review issue 3366` | Target `issue 3366` kept as-is. Review stays review: an explicit assessment outcome. More actionable than the bare verb (states what the review should weigh and produce). | No implementation. No invented issue facts or findings. |
| `check why this hangs` | Target `this` preserved unresolved. Understand-oriented: investigate the hang, distinguish supported causes from assumptions, report findings with next steps. | No implementation. No guessed cause for the hang. `this` not resolved. |
| `do the same as above but without a store` | The reference stays a reference; the `without a store` constraint is preserved explicitly. The repeated-action intent is made actionable. | The prior conversation is not reconstructed. The reference is not resolved from own knowledge. No invented store design. |
| `make this work like claude` | Target `this` and the reference behavior (`like claude`) preserved as unresolved references. Uncertainty about what "like claude" means stays open. | No invented definition of claude's behavior. No guessed target. No implementation. |
| `explain this code` | Target `this` preserved unresolved. Understand-oriented: explain the target, what it does and why, without changing anything. More actionable than "Explain this code." | No implementation or refactor. No invented code behavior beyond what a later read would establish. |
| `move save button up` | Target (save button) and change intent preserved. Position change is made concrete and verifiable without redesigning the UI. | No invented layout system or component names. No extra scope (no refactor, no new feature). |
| `Rename foo to bar in src/a.ts` | Target and path kept exactly. Essentially unchanged — already precise and actionable. Expansion limited to phrasing polish at most. | No padding. No invented side effects, tests, or extra instructions. |

Regression bar: `analyze issue 3366` must not come back equivalent to
"Analyze issue 3366." — a capitalization/punctuation-only rewrite is a
failure.
