# OpenCode Module Documentation

## Purpose
This module provides OpenCode server integration utilities for the web server runtime, including configuration management and provider authentication.

## Entrypoints and structure
- `packages/web/server/lib/opencode/index.js`: public entrypoint (currently baseline placeholder).
- `packages/web/server/lib/opencode/auth.js`: provider authentication file operations.
- `packages/web/server/lib/opencode/auth-state-runtime.js`: managed OpenCode server auth password/header runtime.
- `packages/web/server/lib/opencode/cli-options.js`: CLI/environment option parsing for server startup arguments.
- `packages/web/server/lib/opencode/cli-entry-runtime.js`: CLI entrypoint runtime that detects direct execution, parses CLI options, and starts server bootstrap.
- `packages/web/server/lib/opencode/routes.js`: OpenCode/provider settings and auth-related route registration.
- `packages/web/server/lib/opencode/lifecycle.js`: OpenCode process lifecycle runtime (startup, restart, readiness, health monitoring). After readiness it warms the most recently used directories (`getWarmupDirectories` dep, sequential and best-effort) because OpenCode initializes each directory lazily on first request and that cost would otherwise be paid by the user's first interactive session open. A directory whose warm fetch succeeds is reported once through the optional `onDirectoryWarmed(directory)` dependency, which `index.js` uses to stamp idle-eviction activity.
- `packages/web/server/lib/opencode/provider-env-aliases.js`: mirrors known provider credential env aliases into the managed OpenCode process environment (for example `GEMINI_API_KEY` → `GOOGLE_GENERATIVE_AI_API_KEY`) so OpenCode connection detection and the upstream AI SDK agree on the same key names. Canonical implementation shared by web lifecycle and the VS Code managed spawn path (`packages/vscode/src/provider-env-aliases.ts` re-exports this module).
- `packages/web/server/lib/opencode/env-runtime.js`: OpenCode CLI/binary resolution and shell environment runtime.
- `packages/web/server/lib/opencode/env-config.js`: OpenCode-related environment variable parsing and validation (host/port/hostname).
- `packages/web/server/lib/opencode/hmr-state-runtime.js`: HMR-persistent runtime state initialization, auth-state bootstrap, and HMR sync helpers.
- `packages/web/server/lib/opencode/bootstrap-runtime.js`: base app bootstrap runtime for status/auth/tts/notification/OpenChamber route wiring.
- `packages/web/server/lib/opencode/network-runtime.js`: OpenCode URL construction, health-probe readiness checks, and API prefix runtime.
- `packages/web/server/lib/opencode/project-directory-runtime.js`: request-scoped and settings-backed project directory resolution/validation runtime.
- `packages/web/server/lib/opencode/config-entity-routes.js`: route registration for agent/command/MCP config orchestration with deferred-apply semantics (`restartDeferred` payloads; explicit apply via `POST /api/config/reload`).
- `packages/web/server/lib/opencode/config-mutation-response.js`: shared response builders for deferred OpenCode restarts and external manual-restart guidance.
- `packages/web/server/lib/opencode/snippets.js`: opencode-snippets-compatible snippet file CRUD, discovery, and hashtag expansion.
- `packages/web/server/lib/opencode/cli-options.js`: CLI/environment option parsing for server startup arguments.
- `packages/web/server/lib/opencode/core-routes.js`: server status/system routes, auth/access guard routes, and settings utility route registration.
- `packages/web/server/lib/opencode/shutdown-runtime.js`: graceful shutdown orchestration runtime for watcher/session/terminal/process/server teardown.
- `packages/web/server/lib/opencode/server-startup-runtime.js`: server listen/startup tunnel flow and process/signal handler orchestration runtime.
- `packages/web/server/lib/opencode/static-routes-runtime.js`: static asset/SPA fallback route registration and manifest route wiring.
- `packages/web/server/lib/opencode/feature-routes-runtime.js`: feature route composition runtime for dynamic import-backed config/skill/provider route registration.
- `packages/web/server/lib/opencode/opencode-resolution-runtime.js`: OpenCode binary resolution snapshot runtime for settings routes and diagnostics.
- `packages/web/server/lib/opencode/upgrade-capability.js`: authoritative upgrade ownership policy for the active OpenCode runtime. Bundled, external, and unresolved runtimes fail closed; only managed non-bundled runtimes delegate upgrades to OpenCode.
- `packages/web/server/lib/opencode/tunnel-wiring-runtime.js`: tunnel service/routes composition runtime and active-port wiring for main server startup.
- `packages/web/server/lib/opencode/startup-pipeline-runtime.js`: server startup tail orchestration runtime for terminal/proxy/static/start-listen flow.
- `packages/web/server/lib/opencode/startup-performance.js`: opt-in startup phase diagnostics with fixed labels and numeric metadata allowlists.
- `packages/web/server/lib/agent-tool/runtime.js`: managed OpenCode custom-tool materialization, environment injection, same-machine authentication (loopback, or the bound address for a concrete bind), and fixed CLI action dispatch.
- `packages/web/server/lib/system-prompt/runtime.js`: opt-in managed OpenCode system-prompt optimizer materialization and plugin injection.
- `packages/web/server/lib/opencode/managed-plugin-config.js`: the one `OPENCODE_CONFIG_CONTENT` merge every managed plugin (agent tools, system prompt optimizer) appends itself through.
- `packages/web/server/lib/opencode/server-utils-runtime.js`: shared server runtime utilities for OpenCode proxy wiring, OpenCode port/readiness helpers, and snapshot fetchers.
- `packages/web/server/lib/opencode/openchamber-routes.js`: OpenChamber update and models metadata route registration.
- `packages/web/server/lib/opencode/pwa-manifest-routes.js`: PWA manifest route registration with recent-session shortcut resolution and short-lived caching.
- `packages/web/server/lib/opencode/project-icon-routes.js`: project icon upload/read/discovery route registration and icon storage orchestration.
- `packages/web/server/lib/opencode/skill-routes.js`: route registration for skill config CRUD, supporting files, and skills catalog scan/install flows.
- `packages/web/server/lib/opencode/settings-runtime.js`: Settings persistence runtime (disk IO, migrations, normalization, project validation, and persisted update serialization).
- `packages/web/server/lib/opencode/settings-helpers.js`: Settings payload sanitization/format helpers runtime for response shaping and persisted merge prep.
- `packages/web/server/lib/opencode/settings-normalization-runtime.js`: path/settings/tunnel/idle-instance-timeout normalization and sanitization helpers runtime used by settings/routes/config wiring.
- `packages/web/server/lib/opencode/theme-runtime.js`: custom theme JSON validation and theme directory loading runtime for settings utility routes.

  `POST /api/config/themes` saves a converted VS Code palette. The runtime validates
  literal colors and required authored roles, assigns a content-derived filename,
  and publishes through a same-directory hard link so partial files and overwrites
  are impossible. Identical retries reuse the existing file; a manually edited
  collision returns 409. Temporary files are ignored by the loader and removed
  after publication or failure. Non-missing-directory read failures propagate to
  the route instead of returning an authoritative empty library.

  The common request middleware parses theme POST bodies before these routes;
  integration tests must use that middleware rather than an unrestricted test parser.
  `DELETE /api/config/themes/:id` finds a valid regular JSON file by its metadata ID
  inside the custom themes directory. IDs are never used as filenames. Hand-added
  themes are supported; symlinks and bundled themes are outside deletion ownership.
  Duplicate matching IDs fail explicitly. Missing themes are an idempotent success;
  filesystem failures remain errors.
  `theme-catalog.js` owns POST catalog search/package routes under
  `/api/config/themes/catalog/`. It fetches only Open VSX and its Eclipse CDN over
  HTTPS, validates redirects and checksums, and verifies packaged identity.
  `theme-archive.js` reads selected JSON entries in memory with bounded decompression.
  JSON includes and token references stay inside the package. Each failed variant
  is reported separately so valid siblings remain available. No extension code runs.
- `packages/web/server/lib/opencode/directory-activity-runtime.js`: per-directory activity and in-flight request bookkeeping for managed-instance idle eviction (#3768). The proxy observes directory-scoped `/api` requests and the module exposes the quiet candidate list plus release/deregistration hooks for the idle-instance reaper. Observation-only: it never calls upstream.
- `packages/web/server/lib/opencode/idle-instance-reaper.js`: idle managed-instance reaper (#3768). Every sweep resolves the idle window from merged settings (default 30 min, `0` disables) with `OPENCHAMBER_IDLE_INSTANCE_TIMEOUT_MS` taking precedence, requires a ready managed non-external server, and releases quiet directories through upstream `POST /instance/dispose?directory=`. Sweeps are skipped while restarting or shutting down; the reaper never kills processes.
- `packages/web/server/lib/opencode/proxy.js`: OpenCode API/SSE forwarding and readiness-gate route registration.
- `packages/web/server/lib/opencode/session-runtime.js`: session status/attention/activity runtime for OpenCode SSE events.
- `packages/web/server/lib/opencode/watcher.js`: global SSE watcher runtime for push/session event fanout.
- `packages/web/server/lib/opencode/shared.js`: shared utilities for config, markdown, skills, and git helpers.
- `packages/web/server/lib/ui-auth/ui-auth.js`: UI session authentication runtime (outside OpenCode module).
- `packages/web/server/lib/ui-auth/ui-passkeys.js`: UI passkey storage and WebAuthn registration/authentication helpers (outside OpenCode module).

## Public exports (auth.js)
- `readAuthFile()`: Reads and parses `~/.local/share/opencode/auth.json`.
- `writeAuthFile(auth)`: Writes auth file with automatic backup.
- `removeProviderAuth(providerId)`: Removes a provider's auth entry.
- `getProviderAuth(providerId)`: Returns auth for a specific provider or null.
- `listProviderAuths()`: Returns list of provider IDs with configured auth.
- `AUTH_FILE`: Auth file path constant.
- `OPENCODE_DATA_DIR`: OpenCode data directory path constant.

## Public exports (providers.js)
- `getProviderSources(providerId, workingDirectory)`: Resolves which OpenCode config layers define a provider.
- `upsertProviderConfig(providerId, config, workingDirectory, scope?, options?)`: Validates and writes a custom provider block (`npm`, `name`, `options.baseURL`, `models`, optional `env`/`headers`) into the user/project/custom config layer. The adapter may be OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages. Existing provider, option, and retained-model fields not managed by the form are preserved; omitted models, headers, and env credentials remain explicit removals. Updating a legacy `providers` entry migrates it to the canonical `provider` key. Does not store API keys. Requires `config.env` or `options.hasStoredAuth` (auth already written via OpenCode `auth.set`). Edit flows must pass the provider's effective existing layer (`custom` > `project` > `user`) so updates do not create a global user override.
- `validateCustomProviderConfig(providerId, config, options?)`: Structural validation for custom provider payloads (id format, adapter allowlist `@ai-sdk/openai-compatible`/`@ai-sdk/openai`/`@ai-sdk/anthropic`, http(s) base URL, models, credentials via `env` or `hasStoredAuth`).
- `removeProviderConfig(providerId, workingDirectory, scope?)`: Removes a provider block from the selected config layer.

## Public exports (shared.js)
- `OPENCODE_CONFIG_DIR`, `AGENT_DIR`, `COMMAND_DIR`, `SKILL_DIR`, `CONFIG_FILE`: Path constants rooted at `$XDG_CONFIG_HOME/opencode` when `XDG_CONFIG_HOME` is non-empty, otherwise `~/.config/opencode`. These constants are evaluated when the module loads; no files are migrated. `OPENCODE_CONFIG` remains a separate explicit config-file path and is resolved at call time for the custom config layer; it does not replace the global config directory.
- `AGENT_SCOPE`, `COMMAND_SCOPE`, `SKILL_SCOPE`: Scope constants with USER and PROJECT values.
- `ensureDirs()`: Creates required OpenCode directories.
- `parseMdFile(filePath)`, `writeMdFile(filePath, frontmatter, body)`: Markdown file operations with YAML frontmatter.
- `getConfigPaths(workingDirectory)`, `readConfigLayers(workingDirectory)`, `readConfig(workingDirectory)`: Config file operations with layer merging (user, project, custom). `readConfigLayers` isolates `INVALID_JSONC` per layer: a broken file is omitted from the merge (`{}` for that layer only), recorded on `layerErrors`, and does not block valid sibling layers. Writes still refuse to overwrite the broken file.
- `readConfigFile(filePath)`: Reads one config file. Missing, whitespace-only, and comment-only files return `{}`; a comment-only file is recognized by `ValueExpected` being the only parse error. A `jsonc-parser` error that produces a partial or non-object tree throws `INVALID_JSONC` — partial parse trees must never be treated as authoritative (avoids rewriting a `$schema`-only stub over a full config). Content that yields no JSON value for any other reason (YAML, plain text) also throws instead of reading as empty.
- `readConfigLayer(filePath)`: Same parse as `readConfigFile`, but isolates `INVALID_JSONC` to `{ config: {}, error }` so plugin/MCP/agent readers can skip one broken layer without aborting valid siblings. Writes still refuse to overwrite the broken file.
- `writeConfig(config, filePath)`: Writes config with automatic backup. Refuses to overwrite an existing non-empty file that fails the same JSONC parse check.
- `getJsonEntrySource(layers, sectionKey, entryName)`: Resolves which config layer provides an entry. A failed custom or user layer throws `INVALID_JSONC` instead of treating that file as empty. A failed project layer is skipped so a valid user/custom entry can still be found.
- `getJsonWriteTarget(layers, preferredScope)`: Determines write target for config updates. Throws `INVALID_JSONC` when the chosen target file is the unparseable layer.
- `getAncestors(startDir, stopDir)`, `findWorktreeRoot(startDir)`: Git worktree helpers.
- `isPromptFileReference(value)`, `resolvePromptFilePath(reference)`, `writePromptFile(filePath, content)`: Prompt file reference handling.
- `walkSkillMdFiles(rootDir)`: Recursively finds all SKILL.md files.
- `addSkillFromMdFile(skillsMap, skillMdPath, scope, source)`: Parses and indexes a skill file.
- `resolveSkillSearchDirectories(workingDirectory)`: Returns skill search path order (config, project, home, custom).
- `listSkillSupportingFiles(skillDir)`, `readSkillSupportingFile(skillDir, relativePath)`, `writeSkillSupportingFile(skillDir, relativePath, content)`, `deleteSkillSupportingFile(skillDir, relativePath)`: Skill supporting file management.

## Public exports (routes.js)
- `registerOpenCodeRoutes(app, dependencies)`: Registers OpenCode-owned HTTP routes and internal module runtime:
  - `GET /api/config/settings`
  - `PUT /api/config/settings`
  - `GET /api/config/opencode-resolution`
  - `POST /api/opencode/upgrade` (enforces the active runtime's upgrade capability, serializes supported OpenCode upgrades, then restarts managed OpenCode so the new binary is active)
  - `GET /api/opencode/upgrade-status` (returns version availability plus the authoritative `upgrade.supported`, `upgrade.manager`, and `upgrade.reason` capability)
  - `POST /api/opencode/directory` (validates and activates an existing project directory; `{ create: true }` explicitly creates the requested project directory before activation, including outside the previously active workspace)
  - `GET /api/provider/:providerId/source`
  - `PUT /api/provider` (create/update custom OpenAI-compatible provider config in OpenCode user/project/custom layers via `scope`; secrets stay in auth via the OpenCode auth API)
  - `DELETE /api/provider/:providerId/auth`
- Owns lazy auth library loading for provider auth checks/removal.
- Keeps route behavior independent from composition root; `index.js` now supplies dependencies only.

## Public exports (session-runtime.js)
- `createSessionRuntime({ writeSseEvent, getNotificationClients, broadcastEvent? })`: creates runtime-owned state machine and APIs for session status.
- Returned API:
  - `processOpenCodeSsePayload(payload)`
  - `getSessionActivitySnapshot()`
  - `getActiveSessionCount()`
  - `getSessionStateSnapshot()`
  - `getSessionAttentionSnapshot()`
  - `getSessionState(sessionId)`
  - `getSessionAttentionState(sessionId)`
  - `markSessionViewed(sessionId, clientId)`
  - `markSessionUnviewed(sessionId, clientId)`
  - `markUserMessageSent(sessionId)`
  - `resetAllSessionActivityToIdle()`
  - `interruptBusySessionsAfterRestart()`: settles every session whose authoritative status is `busy`/`retry` or whose activity phase is still busy, broadcasts `openchamber:session-status` idle plus an OpenCode-shaped `session.error`, resets leftover activity/cooldowns, and returns the interrupted session IDs in stable order.
  - `dispose()`

The runtime maintains active-session count incrementally from idempotent activity phase transitions. Upstream stall-timeout and lifecycle health checks read it in O(1); the hourly cleanup removes activity phases older than 24 hours without broadcasting synthetic state transitions. Snapshot generation remains reserved for the session-activity API.

## Public exports (lifecycle.js)
- `createOpenCodeLifecycleRuntime(dependencies)`: creates lifecycle runtime for managed/external OpenCode process orchestration. The optional `onOpenCodeRestarted` dependency (default `null`) is fired after a successful managed restart. `index.js` rebinds event-stream readers to the possibly-new port (#2638), then calls `interruptBusySessionsAfterRestart()` and broadcasts one `opencode-restart-interrupted` UI notification when interrupted turns exist (#2943). The optional `onDirectoryWarmed(directory)` dependency (default `null`) is awaited once per directory after a successful startup warm fetch; a failed or aborted warm fetch does not call it. Without the dependency the warmup pass behaves exactly as before.
- Returned API:
  - `startOpenCode()`
  - `restartOpenCode()`
  - `waitForOpenCodeReady(timeoutMs?, intervalMs?)`
  - `waitForAgentPresence(agentName, timeoutMs?, intervalMs?)`
  - `refreshOpenCodeAfterConfigChange(reason, options?)`
  - `bootstrapOpenCodeAtStartup()`
  - `startHealthMonitoring(healthCheckIntervalMs)`
  - `waitForPortRelease(port, timeoutMs, hostname?)`
  - `killProcessOnPort(port)`

Managed OpenCode launch also merges the environment returned by the agent-tool
runtime and the opt-in system prompt optimizer, each appending its `file://`
entry to the previous one's config. OpenChamber adds no automatic MCP reconnect
loop; recovery after a failed connection is manual for both local and remote
servers. Previously generated reconnect plugin files are inert because managed
launch no longer registers them. User-configured plugins remain user-owned.
PATH and `OPENCODE_SERVER_PASSWORD` remain lifecycle-owned and cannot
be replaced by injected values. External OpenCode processes receive no
OpenChamber tool injection. Managed launch env strips AppImage `ARGV0` before
spawn so zsh-backed OpenCode tools do not rewrite child argv[0] to the AppImage
path (#2588).

Before spawn, `applyProviderEnvAliases` fills unset Google credential aliases
from any present sibling (`GOOGLE_GENERATIVE_AI_API_KEY`, `GOOGLE_API_KEY`,
`GEMINI_API_KEY`) so a shell that only exports `GEMINI_API_KEY` still satisfies
the Generative AI SDK path used at chat time. Existing non-empty values are
never overwritten.

Set `OPENCHAMBER_STARTUP_PERF=1` to emit bounded startup phase records for server listen, managed OpenCode preparation/readiness, and proxy readiness holds. Every OpenCode bootstrap emits one terminal `opencode.bootstrap.ready` or `opencode.bootstrap.error` event, including reused and external server paths. Records contain controlled phase/outcome/route labels and timing values only; they never contain request URLs, runtime keys, directories, session IDs, credentials, or content.

macOS `say` voice enumeration starts concurrently with server composition. The server listener and managed OpenCode startup do not wait for it; `/api/tts/say/status` awaits the same authoritative capability promise when queried before enumeration completes.

Transport-triggered health checks share the periodic monitor's failure accounting interval. Rapid WS reconnect callbacks therefore cannot exhaust the managed-process restart threshold using one cached unhealthy result; an exited managed process still restarts immediately.

Managed health failures are classified as `timeout`, `connection_refused`, `connection_reset`, `invalid_response`, or `error`. The lifecycle retains the latest counted failure with a bounded detail string and source. Managed process wrappers continue capturing a sanitized, bounded stderr tail after readiness and retain exit code/signal. Before replacing a managed process, lifecycle snapshots the reason, latest health failure, process diagnostics/aliveness, busy-session count, and timestamp into `lastOpenCodeRestartDiagnostics`; successful startup does not clear this snapshot, and `/health` exposes it for post-restart diagnosis without process environment or credentials.

Managed process ownership starts at spawn. The registry and runtime process
handle include children that have not announced readiness yet, so shutdown can
stop an in-flight startup. Readiness timeout, malformed startup output, and
health-probe errors close that child before retrying. Shutdown cancels further
startup attempts. Closing a process is single-flight and unregisters it only
after it exits.

On Windows, managed teardown invokes the existing tree termination command
before terminating the root. Calling `child.kill()` first loses the ancestry
needed to find Git, shell, and MCP descendants. On POSIX, the managed child
starts in its own process group and teardown escalates against that group even
if the root has already exited. A tool ignoring SIGTERM must not survive just
because the server closed its own pipes. The
`lifecycle-process.test.js` regressions launch real parent/child fixtures and
check PID exit plus registry cleanup. macOS results do not validate Windows
ConPTY or Console Window Host behavior.

## Public exports (env-runtime.js)
- `createOpenCodeEnvRuntime(dependencies)`: creates runtime that owns OpenCode CLI environment and binary discovery state.
- OpenCode CLI resolution order is persisted settings, environment overrides, bundled Desktop CLI when available, PATH, known install locations, then platform shell discovery.
- Automatic bundled resolution under `OPENCHAMBER_RUNTIME=desktop` stays in runtime state and is returned to the managed launch function, including on OpenCode restart. It does not populate `process.env.OPENCODE_BINARY`: AppImage updater relaunch inherits that environment and would mistake the previous bundle path for an explicit override. Explicit settings/env selections and non-desktop or non-bundled resolution retain their existing environment behavior. This prevents future inheritance; it does not reinterpret overrides already inherited from older releases.
- Returned API:
  - `applyLoginShellEnvSnapshot()`
  - `getLoginShellEnvSnapshot()`
  - `ensureOpencodeCliEnv()`
  - `applyOpencodeBinaryFromSettings()`
  - `resolveOpencodeCliPath()`
  - `resolveManagedOpenCodeLaunchSpec(opencodePath)`: resolves the effective managed OpenCode launch target, unwrapping Windows package-manager shims to a direct native binary or explicit runtime+script when possible.
  - `resolveGitBinaryForSpawn()`
  - `resolveWslExecutablePath()`
  - `buildWslExecArgs(execArgs, distroOverride?)`
  - `isExecutable(filePath)`
  - `searchPathFor(binaryName, searchPath?)`: resolves an executable from the supplied PATH value, defaulting to the process PATH.
  - `clearResolvedOpenCodeBinary()`

## Public exports (env-config.js)
- `resolveOpenCodeEnvConfig(options?)`: resolves and validates OpenCode host/port/hostname environment configuration.
- Returned object fields:
  - `configuredOpenCodePort`
  - `configuredOpenCodeHost`
  - `effectivePort`
  - `configuredOpenCodeHostname`

## Public exports (hmr-state-runtime.js)
- `createHmrStateRuntime(dependencies)`: creates runtime for HMR state container initialization and runtime<->HMR state synchronization.
- Returned API:
  - `getOrCreateHmrState()`
  - `ensureUserProvidedOpenCodePassword(hmrState)`
  - `getUserProvidedOpenCodePassword(hmrState)`
  - `resolveOpenCodeAuthFromState({ hmrState, userProvidedOpenCodePassword })`
  - `syncStateFromRuntime(hmrState, runtime)`
  - `restoreRuntimeFromState({ hmrState, userProvidedOpenCodePassword })`

## Public exports (bootstrap-runtime.js)
- `createBootstrapRuntime(dependencies)`: creates runtime for base app route bootstrap and UI auth controller initialization.
- Returned API:
  - `setupBaseRoutes(app, options)`

## Public exports (network-runtime.js)
- `createOpenCodeNetworkRuntime(dependencies)`: creates runtime for OpenCode network and URL concerns.
- Returned API:
  - `waitForReady(url, timeoutMs?)`
  - `normalizeApiPrefix(prefix)`
  - `setDetectedOpenCodeApiPrefix()`
  - `buildOpenCodeUrl(path, prefixOverride?)`
  - `ensureOpenCodeApiPrefix()`
  - `scheduleOpenCodeApiDetection()`

## Public exports (settings-runtime.js)
- `createSettingsRuntime(dependencies)`: creates settings lifecycle runtime for read/migrate/persist concerns.
- Returned API:
  - `readSettingsFromDisk()`
  - `readSettingsFromDiskMigrated()`
  - `writeSettingsToDisk(settings)`
  - `persistSettings(changes)`
- Persistent permission auto-accept policy is stored under `permissionAutoAccept`; execution ownership lives in `lib/permission-auto-accept/`.
- Idle managed-instance eviction (#3768) is configured by `idleInstanceTimeoutMs` (instance scope, `settings.json`): the idle window in milliseconds before a managed directory instance is released. An absent key resolves to the default `1800000` (30 minutes) and `0` disables eviction; negative, non-finite, and non-number values normalize to the default, so a malformed write can neither error nor disable eviction.
- `OPENCHAMBER_IDLE_INSTANCE_TIMEOUT_MS` overrides the persisted `idleInstanceTimeoutMs` whenever it parses to a finite non-negative number (`0` disables). An unset or unparsable override leaves the setting in effect. The override is read on every sweep, so a change applies without a restart.
- Queued follow-up messages live in `<data-dir>/message-queue.json`, not in settings; execution ownership lives in `lib/message-queue/`.
- Shared sidebar preferences are stored as validated top-level fields: `sidebarProjectDisplayMode`, `sidebarSessionGroupingMode`, `sidebarProjectSortOrder`, and `sidebarShowRecentSection`. Device-local picker selection and sticky-header state do not enter either settings file.
- Two files (`settings-files.js`): `settings.json` holds instance facts and any legacy or unknown keys; `preferences.json` beside it holds every key the generated registry snapshot (`settings-registry.json`) marks `profile`, as `{ version: 1, fields: { key: { value, updatedAt, surfaces? } } }`. Keys the snapshot marks `perSurface` are stored per surface kind: `GET`/`PUT /api/config/settings` read the client's kind from the `surface` query parameter (`settingsSurfaceOf`; the legacy `x-openchamber-surface` header is still honoured, but a header forces a CORS preflight that cross-origin shells and older instances refuse, so clients must not send one) (`web`, `desktop`, `vscode`, `mobile`; anything else means base), `persistSettings(changes, { surface })` writes a changed per-surface key under `surfaces[surface]` and never touches its base, and `readSettingsFromDisk({ surface })` resolves that kind's value first, the base otherwise. Callers without a surface (migrations, the seed, server-side feature writers) read and write the base. `readSettingsFromDisk()` returns the merged document and seeds `preferences.json` once from an existing `settings.json` (which it leaves intact). An existing `preferences.json` that fails to parse is a failure, not an empty profile: it is never seeded or overwritten, the merged read serves the instance part, and `persistSettings` drops profile keys with a warning until the file is fixed or removed. `writeSettingsToDisk(document)` splits by scope and writes `settings.json` as the instance part plus a copy of the profile's base values (`legacySettingsDocumentOf`): a build from before the split reads only that file, so a rollback keeps the user's preferences, while current builds ignore the copy because `preferences.json` wins in the merge; device keys are dropped from writes. Modules that read one profile key off the disk on a hot path use `readMergedSettingsSync`.

## Public exports (settings-files.js)
- `parsePreferencesDocument(raw)`, `serializePreferencesDocument(fields)`, `flattenPreferences(fields)`, `buildPreferencesFields(previousFields, document, now)`, `instancePartOf(document)`, `seedPreferencesFrom(document, now)`, `readMergedSettingsSync({ fs, path, settingsFilePath })`, `getSettingsScope(key)`, `isProfileSettingsKey(key)`, `isDeviceSettingsKey(key)`, `preferencesFilePathFor(settingsFilePath, path)`.
- The VS Code extension host writes the same two files with the same shape (`packages/vscode/src/settings-files.ts`); format changes go to both.

## Public exports (settings-helpers.js)
- `createSettingsHelpers(dependencies)`: creates settings helper runtime for settings request/response shaping.
- Returned API:
  - `normalizePwaAppName(value, fallback?)`
  - `sanitizeSettingsUpdate(payload)`
  - `mergePersistedSettings(current, changes)`
  - `formatSettingsResponse(settings)`

## Public exports (settings-normalization-runtime.js)
- `createSettingsNormalizationRuntime(dependencies)`: creates normalization/sanitization runtime for shared settings and tunnel helper logic.
- Returned API:
  - `normalizeDirectoryPath(value)`
  - `normalizePathForPersistence(value)`
  - `normalizeSettingsPaths(input)`
  - `normalizeTunnelBootstrapTtlMs(value)`
  - `normalizeTunnelSessionTtlMs(value)`
  - `normalizeIdleInstanceTimeoutMs(value)`
  - `normalizeManagedRemoteTunnelHostname(value)`
  - `normalizeManagedRemoteTunnelPresets(value)`
  - `normalizeManagedRemoteTunnelPresetTokens(value)`
  - `isUnsafeSkillRelativePath(value)`
  - `sanitizeTypographySizesPartial(input)`
  - `normalizeStringArray(input)`
  - `sanitizeModelRefs(input, limit)`
  - `sanitizeSkillCatalogs(input)`
  - `sanitizeProjects(input)`

## Public exports (theme-runtime.js)
- `createThemeRuntime(dependencies)`: creates custom theme runtime for on-disk theme discovery and JSON normalization/validation.
- Returned API:
  - `normalizeThemeJson(raw)`
  - `readCustomThemesFromDisk()`

## Public exports (project-directory-runtime.js)
- `createProjectDirectoryRuntime(dependencies)`: creates runtime for request/project directory candidate normalization and validation.
- Returned API:
  - `resolveDirectoryCandidate(value)`
  - `validateDirectoryPath(candidate)`
  - `resolveProjectDirectory(req)`
  - `resolveOptionalProjectDirectory(req)`

## Public exports (config-entity-routes.js)
- `registerConfigEntityRoutes(app, dependencies)`: registers configuration entity routes:
  - Agents: `/api/config/agents/:name` and `/api/config/agents/:name/config`
  - Commands: `/api/config/commands/:name`
  - MCP servers: `/api/config/mcp` and `/api/config/mcp/:name`
  - Snippets: `/api/config/snippets`, `/api/config/snippets/:name`, and `/api/config/snippets/expand`
- Agent/command/MCP write routes persist config to disk and return a deferred-restart payload (`requiresReload: false`, `requiresRestart: true`, `restartDeferred: true`) instead of restarting OpenCode immediately. The UI accumulates these changes and applies them with `POST /api/config/reload`.

## Public exports (config-mutation-response.js)
- `buildDeferredRestartResponse(message)`: success payload for config mutations that are saved on disk but waiting for an explicit Apply & Restart (`restartDeferred: true`).
- `buildExternalManualRestartResponse(message)`: success payload when OpenCode is an external process and the operator must restart it manually (`requiresManualRestart: true`).

## Public exports (auth-state-runtime.js)
- `createOpenCodeAuthStateRuntime(dependencies)`: creates runtime for managed OpenCode auth password state and request headers.
- Returned API:
  - `getOpenCodeAuthHeaders()`
  - `isOpenCodeConnectionSecure()`
  - `ensureLocalOpenCodeServerPassword(options?)`

## Public exports (core-routes.js)
- `registerServerStatusRoutes(app, dependencies)`: registers status/system endpoints:
  - `GET /health`
  - `POST /api/system/shutdown`
  - `GET /api/system/info`
 - `registerAuthAndAccessRoutes(app, dependencies)`: registers browser auth/session exchange and API access middleware:
   - `GET /auth/session`
   - `POST /auth/session`
   - `GET /auth/passkey/status`
   - `POST /auth/passkey/authenticate/options`
   - `POST /auth/passkey/authenticate/verify`
   - `POST /auth/passkey/register/options`
   - `POST /auth/passkey/register/verify`
   - `GET /api/passkeys`
   - `DELETE /api/passkeys/:id`
   - `POST /api/auth/reset`
   - `GET /connect`
   - `POST /api/system/probe-url`
   - `app.use('/api', ...)` auth/tunnel guard
- `registerSettingsUtilityRoutes(app, dependencies)`: registers small settings utility endpoints:
  - `GET /api/config/themes`
  - `POST /api/config/reload` — applies accumulated deferred OpenCode config changes. Managed OpenCode restarts and returns `requiresReload: true`. External OpenCode returns `requiresManualRestart: true` (changes are already on disk; the connected server must be restarted outside OpenChamber).
- `registerCommonRequestMiddleware(app, dependencies)`: registers shared request middleware stack:
  - conditional JSON body parser behavior for `/api/*` vs non-API requests
  - URL-encoded parser setup
  - request logging middleware

## Public exports (cli-options.js)
- `parseServeCliOptions(options)`: parses serve CLI flags and environment-derived defaults:
  - Port/host/ui-password
  - Tunnel provider/mode/config/token/hostname
  - Legacy `--tunnel` shorthand normalization

## Public exports (cli-entry-runtime.js)
- `runCliEntryIfMain(dependencies)`: detects direct CLI execution and runs server startup with parsed CLI options.

## Public exports (server-utils-runtime.js)
- `createServerUtilsRuntime(dependencies)`: creates server utility runtime for OpenCode orchestration helpers. The optional `observeDirectoryRequest` dependency is forwarded into `registerOpenCodeProxy`, so both `setupProxy` callers (startup pipeline and lifecycle restart) keep observing directory activity.
- Returned API:
  - `setOpenCodePort(port)`
  - `waitForOpenCodePort(timeoutMs?)`
  - `buildAugmentedPath()`
  - `parseSseDataPayload(block)`
  - `fetchAgentsSnapshot()`
  - `fetchProvidersSnapshot()`
  - `fetchModelsSnapshot()`
  - `setupProxy(app)`

## Public exports (shutdown-runtime.js)
- `createGracefulShutdownRuntime(dependencies)`: creates graceful shutdown runtime for managed OpenCode and web server teardown sequencing.
- Stops the idle-instance reaper (`idleInstanceReaper.stop()`) with the other owned runtimes, so no sweep starts once shutdown begins.
- After stopping owned runtimes and OpenCode, HTTP shutdown closes active connections as well as the listener. A remaining SSE response must not hold Desktop open until its fallback deadline. Upgraded sockets remain the responsibility of their owning runtime.
- Returned API:
  - `gracefulShutdown(options?)`

## Public exports (server-startup-runtime.js)
- `createServerStartupRuntime(dependencies)`: creates runtime for server bind/startup tunnel and process handler wiring.
- Returned API:
  - `resolveBindHost(host)`
  - `startListeningAndMaybeTunnel(options)`
  - `attachProcessHandlers(options)`

## Public exports (static-routes-runtime.js)
- `createStaticRoutesRuntime(dependencies)`: creates runtime for static dist resolution and static route registration.
- Returned API:
  - `registerStaticRoutes(app)`

## Public exports (feature-routes-runtime.js)
- `createFeatureRoutesRuntime(dependencies)`: creates runtime for main feature route registration orchestration.
- Returned API:
  - `registerRoutes(app, routeDependencies)`

## Public exports (opencode-resolution-runtime.js)
- `createOpenCodeResolutionRuntime(dependencies)`: creates runtime for OpenCode binary/source snapshot resolution.
- Returned API:
  - `getOpenCodeResolutionSnapshot(settings)`: returns configured/resolved OpenCode binary details plus effective managed-launch fields (`launchBinary`, `launchArgs`, `launchWrapperType`) when applicable.

## Public exports (tunnel-wiring-runtime.js)
- `createTunnelWiringRuntime(dependencies)`: creates runtime for tunnel service construction and tunnel route registration.
- Returned API:
  - `initialize(app, initialPort)`

## Public exports (startup-pipeline-runtime.js)
- `createStartupPipelineRuntime(dependencies)`: creates runtime for terminal wiring, proxy/bootstrap scheduling, static route registration, and server startup/listen flow.
- Returned API:
  - `run(options)`

The pipeline binds the OpenChamber listener and publishes its active port
before starting managed OpenCode. The managed custom tool therefore receives
an authoritative loopback callback URL even when OpenChamber binds port `0`.

## Public exports (openchamber-routes.js)
Browser completion checks use `appType=web&updateStatus=true` to stay on the
Desktop Host's native updater. A rejected native restart is retained in the
server process and returned to these polls as `DESKTOP_UPDATE_RESTART_FAILED`;
ordinary availability checks remain usable so a browser reload can offer a
retry. Starting another installation clears the previous restart error.
The shared UI's `lib/web-update.ts` parses install/check responses and waits
for the installed native target version, rather than treating absence of a
newer release as installation success. Poll requests have individual deadlines
within a ten-minute overall deadline.

- `registerOpenChamberRoutes(app, dependencies)`: registers OpenChamber endpoints:
  - `GET /api/openchamber/update-check`
  - `POST /api/openchamber/update-install`
    - Desktop-managed hosts delegate authenticated Web update requests to the Electron main process, which checks, downloads, and applies the update through `electron-updater` before restarting the host.
    - Foreground servers running under a systemd user unit queue installation in
      a separate transient unit and restart the configured service afterwards.
      `OPENCHAMBER_SYSTEMD_UNIT` overrides the default `openchamber.service`.
    - On Windows the install-and-restart script is written to
      `<data dir>/update-install.cmd` before the response and run with
      `cmd.exe /c <file>`. A newline ends a `cmd.exe /c` command line, so the
      same script passed as an argument ran nothing and exited 0; the batch
      file keeps every line. The package-manager line is `call`ed because
      npm, pnpm and yarn are `.cmd` shims that would otherwise end the script,
      the pre-install pause is a loopback `ping` because `timeout` rejects a
      detached child's stdin, and the file deletes itself on its last line
      because the restart command carries the server's flags. If the file
      cannot be written the route answers 500 and the server keeps running.
      The listener is closed before the batch is spawned: on Windows the
      detached child inherits the listening socket and would hold the port
      for the whole batch, so the restart inside it failed with "port already
      in use" and the update ended with no server.
  - `GET /api/openchamber/models-metadata`
  - `GET /api/zen/models`

## Public exports (pwa-manifest-routes.js)
- `registerPwaManifestRoute(app, dependencies)`: registers PWA manifest endpoint with dynamic app-name resolution and recent-session shortcuts:
  - `GET /manifest.webmanifest`

## Public exports (project-icon-routes.js)
- `registerProjectIconRoutes(app, dependencies)`: registers project icon routes and owns icon storage/discovery flow:
  - `GET /api/projects/:projectId/icon`
  - `PUT /api/projects/:projectId/icon`
  - `DELETE /api/projects/:projectId/icon`
  - `POST /api/projects/:projectId/icon/discover`

## Public exports (skill-routes.js)
- `registerSkillRoutes(app, dependencies)`: registers skills-related routes:
  - Skills config CRUD and metadata under `/api/config/skills*`
  - Skill rename via `PATCH /api/config/skills/:name` with `{ renameTo }` (directory rename preserves `SKILL.md` body and supporting files; restricted to managed skill roots under `.opencode/skills|skill`, `.claude/skills`, and `.agents/skills`)
  - Skill list responses include authoritative `renamable` derived from the same managed-root policy used by rename
  - Skills catalog listing/source pagination, scan, and install routes
  - Supporting skill file read/write/delete routes
  - Directory resolution prefers an explicit request directory, then soft-falls
    back to the active project / `lastDirectory` so repository-local
    `.agents/skills` and `.opencode/skills` remain discoverable when the client
    omits `directory`. Requests without any project still list user-scoped skills.

## Public exports (directory-activity-runtime.js)
- `createDirectoryActivityRuntime({ realpath, now?, isWin32? })`: creates the per-directory tracker for managed-instance idle eviction. Keys are canonicalized through the same realpath cache the proxy query canonicalizer uses and lowercased on win32; clock and realpath are injectable for deterministic tests.
- Returned API:
  - `observeRequest(directory)`: stamps `lastActivityAt`, increments `inflight`, and resolves to a release function that decrements exactly once (repeated calls are no-ops). Missing or empty directories resolve to a no-op release.
  - `stampActivity(directory)`: stamps `lastActivityAt` for OpenChamber-owned upstream work that never passes the proxy observer (startup warmup, queued-message dispatch, scheduled-task runs) without touching `inflight`; a not-yet-observed, non-empty directory becomes tracked with zero in-flight work. Returns whether a directory was stamped.
  - `matchesDirectory(key, directory)`: synchronous comparison between a tracked `key` (from `snapshot()`) and a directory string in another form. An exact key matches while the entry is tracked; otherwise the string must be a spelling already observed for that key (win32 case-folded), which is how the reaper's queue predicate survives a symlinked client path. Missing values and untracked keys return false.
  - `noteReleased(directory)`: removes the entry after a successful upstream dispose, so a second dispose needs newly observed activity. Observed spellings for the entry are dropped with it.
  - `deregister(directory)`: removes the entry when the caller reports an upstream `server.instance.disposed` event.
  - `snapshot()`: copies of `{ directory, lastActivityAt, inflight }`.
  - `listQuietDirectories(idleMs)`: entries with no in-flight request and no activity for at least `idleMs`, oldest first; invalid or negative windows return no candidates.
- Tracking is observation-only: a directory nobody observed is never a candidate (I1), and nothing in this module calls upstream. `index.js` subscribes to the shared global event hub and calls `deregister()` for `server.instance.disposed` events that carry a directory, stamps warmup directories (`onDirectoryWarmed`) plus queue dispatches, scheduled-task runs, and hub work events (`onDirectoryActivity`), and passes `matchesDirectory` into the reaper's queue predicate.

## Public exports (idle-instance-reaper.js)
- `createIdleInstanceReaper(dependencies)`: creates the reaper that releases quiet directory instances of a managed OpenCode server. Dependencies:
  - `tracker` (`directory-activity-runtime.js`): candidate source and release bookkeeping.
  - `readSettings`: merged settings reader; `idleInstanceTimeoutMs` is the configured window.
  - `hasQueuedWork(directory)`: message-queue predicate covering queued items and in-flight sends, matched through the tracker so win32 casing and symlinked spellings for the same key still block.
  - `getOpenCodePort`, `isManagedOpenCodeReady`, `isExternalOpenCode`, `isRestartingOpenCode`, `isShuttingDown`: lifecycle guards.
  - `buildOpenCodeUrl`, `getOpenCodeAuthHeaders`: probe and dispose URL/auth, used directly so probes bypass the proxy and are never stamped as activity.
  - `env`, `fetchImpl`, `now`, `logger`, `sweepIntervalMs`, `disposeTimeoutMs`: environment override and test seams; the production defaults are the module constants.
- Returned API:
  - `start()`: schedules sweeps every 60 s (idempotent; the timer does not keep the process alive).
  - `stop()`: clears the sweep timer. Shutdown calls it; an in-flight dispose stays bounded by its 15 s timeout.
  - `runSweep()`: runs one sweep now and resolves when it settles; exposed for deterministic tests and diagnostics.
- Behavior:
  - Configuration is resolved on every sweep and never cached: `OPENCHAMBER_IDLE_INSTANCE_TIMEOUT_MS` wins when it parses to a finite non-negative number, otherwise the merged `idleInstanceTimeoutMs` is normalized (default `1800000`). `0` disables sweeps; a failed settings read skips the sweep instead of assuming the default.
  - At most 10 candidates per sweep, oldest quiet first, each verified at decision time: no in-flight proxied request, no `busy`/`retry` entry in `/session/status`, empty `/permission`, empty `/question` (a 404 means the endpoint is unsupported and the remaining probes decide), and `hasQueuedWork` false. OpenChamber-owned queue work never passes the proxy observer, so the queue snapshot is part of the decision instead. The tracker entry and `hasQueuedWork` are read again immediately before the dispose request: the probes await, and a queue dispatch or scheduled run stamps activity without touching `inflight`, so a stamp that lands mid-probe reschedules the candidate instead of being disposed.
  - Any other probe non-2xx, malformed payload, transport failure, or a probe/dispose URL that cannot be built because the port is gone skips only that candidate and backs it off for 5 minutes (fail closed, I6); the remaining candidates are unaffected. A failed or timed-out dispose keeps the tracker entry with the same backoff, while a successful dispose calls `noteReleased` so a second dispose needs new observed activity.
  - The sweep captures the managed port and aborts if it changes; restarting and shutting-down runtimes are skipped. The reaper never kills a process, touches the port, or restarts anything.
  - Logs one `[instance-reaper]` line per release and per failure with status or transport class, plus a sweep summary only when something was released or failed. A successful dispose whose tracker entry was already deregistered by another path (for example `server.instance.disposed`) logs the truthful outcome at debug instead of as a release. No credentials or session content.

## Public exports (proxy.js)
- `registerOpenCodeProxy(app, dependencies)`: registers OpenCode proxy routes and middleware.
- Owns:
  - SSE forwarders: `GET /api/global/event`, `GET /api/event`
    - Downstream heartbeats keep clients and intermediaries alive, while a separate upstream-only stall watchdog closes the downstream response when OpenCode stops producing bytes so clients reconnect instead of trusting synthetic heartbeats indefinitely. Each watchdog reset uses the current load-aware timeout, matching the shared event transport.
  - Session message forwarder: `POST /api/session/:sessionId/message`
  - Interactive OAuth forwarder: `POST /api/provider/:providerID/oauth/callback`
    - Upstream blocks inside this call for the whole browser sign-in (device-code polling or a loopback redirect), so it is exempt from the ordinary request deadline and uses a 15-minute proxy timeout instead of `LONG_REQUEST_TIMEOUT_MS`. All other `/api/provider/*` routes, including `oauth/authorize`, keep the ordinary deadline.
  - Generic `/api/*` forwarding with hop-by-hop header filtering
  - Windows `/session` merge fallback path behavior
  - OpenCode readiness gate for proxied `/api` requests
  - Directory activity observation: when the optional `observeDirectoryRequest(directory)` dependency is supplied, every `/api` request carrying a `directory` query or `x-opencode-directory` header (after URI decoding, the same rule the worktree gate uses) stamps last activity and registers one in-flight request, released once on `finish`, `close`, or `error`. The middleware sits between the readiness gate and the worktree gate, so a request held by a worktree bootstrap still counts as in-flight. Without the dependency the middleware is never registered and forwarding is unchanged.
  - Worktree checkout gate before directory-scoped upstream reads and writes

Git bootstrap must reach `git-ready` before OpenCode can cache a new worktree's
project identity or config. Setup scripts may still be running; the optional UI
setup wait remains separate. Failed or timed-out checkout returns 503 without
forwarding. The shared draft creator keeps the project directory selected until
creation returns, because preview paths have no bootstrap state.

This server gate covers web, Electron, hosted mobile, and Capacitor connections.
The VS Code extension owns its separate Git and proxy implementation.

## Public exports (watcher.js)
- `createOpenCodeWatcherRuntime(dependencies)`: creates global event watcher runtime backed by the shared upstream SSE reader.
- Dependencies:
  - `waitForOpenCodePort`, `buildOpenCodeUrl`, `getOpenCodeAuthHeaders`, `onPayload`, `fetchImpl`, `upstreamStallTimeoutMs`, `upstreamReconnectDelayMs`: readiness, connection, and forwarding seams.
  - `globalEventHub`: optional shared global message-stream hub; when present the watcher subscribes to it instead of opening its own upstream stream.
  - `onDirectoryActivity`: optional `(directory) => void | Promise<void>`. When supplied, a work event carrying an envelope directory calls it before `onPayload`, which restarts that directory's idle-eviction window (#3768, decision 8).
- Returned API:
  - `start()`
  - `stop()`
- Behavior:
  - Waits for OpenCode readiness before attaching the watcher.
  - In production wiring, subscribes to the shared global message-stream hub instead of opening its own `/global/event` connection.
  - Can still create its own `/global/event` reader when no shared hub is provided, which keeps module tests and isolated reuse simple.
  - Reuses event-stream parsing, `Last-Event-ID`, stall timeout, and reconnect behavior.
  - Forwards unwrapped global event payloads into notification/session side effects.
  - Stamps work-event activity best-effort on both paths (shared hub and own reader): events whose type starts with `session.`, `message.`, `permission.`, or `question.` and that carry an envelope directory call `onDirectoryActivity` with that directory. The prefixes cover the v2 families too (`session.next.*`, `message.part.*`, `permission.v2.*`, `question.v2.*`). Directory-less events and the `global` envelope are ignored. All other families are deliberately excluded, including `lsp.updated`, `file.watcher.updated`, `file.edited`, `installation.updated`, `project.*`, `pty.*`, `todo.updated`, `tui.*`, and server/disposal lifecycle events, because idle LSP and file-watcher processes keep emitting them and stamping them would keep instances resident forever. A missing, throwing, or rejecting callback never delays or skips `onPayload`.

## Storage and configuration
- Provider auth: `~/.local/share/opencode/auth.json`.
- User config: `$XDG_CONFIG_HOME/opencode/opencode.json`, falling back to `~/.config/opencode/opencode.json` when unset or blank.
- Project config: `<workingDirectory>/.opencode/opencode.json` or `opencode.json`.
- Custom config: `OPENCODE_CONFIG` env var path.
- Rate limit config: `OPENCHAMBER_RATE_LIMIT_MAX_ATTEMPTS`, `OPENCHAMBER_RATE_LIMIT_NO_IP_MAX_ATTEMPTS` env vars.

## Notes for contributors
- This module serves as foundation for OpenCode-related server utilities.
- Route ownership moved to module-level `routes.js`; `index.js` wires dependencies only.
- All file writes include automatic backup before modification.
- Config merging follows priority: custom > project > user.
- UI auth uses scrypt for password hashing with constant-time comparison.
- Tunnel auth treats `host.docker.internal` as local-only when the socket remote IP is private/loopback.

The behavior `GET /api/behavior/agents-md` response includes `path`, the effective
server-side filename, whether or not the file exists. Settings displays this
path without deriving a directory from the browser environment.
