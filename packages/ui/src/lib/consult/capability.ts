import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { isServerOwnedMessageQueue } from '@/stores/messageQueueStore';

/**
 * Consult Models mechanism capability (plan risk 9 / WP0.4).
 *
 * The mechanism Phase 0 verified is: a turn-scoped `system` on the advisor
 * send, a wildcard deny-all session permission, a hidden advisor fork, and a
 * request body that survives the active runtime's transport (the web proxy
 * and the VS Code bridge). The transport half was **not** verified (Phase 0
 * A7), and this module is the single place that answers what can be assumed.
 *
 * There is no reliable signal for the transport half:
 *
 * - `opencodeClient.getApp()` returns a hardcoded OpenAPI spec version
 *   (`"0.0.3"`), not a server capability surface;
 * - the OpenChamber server exposes no `experimental.capabilities` endpoint
 *   and no consult-specific capability flag;
 * - the runtime descriptor (`isServerOwnedMessageQueue`, `isVSCodeRuntime`)
 *   says which runtime this is, not what its bridge forwards.
 *
 * The one real runtime signal is the server-owned message queue: admission is
 * impossible without it (VS Code has none), so a runtime without it is
 * `unsupported-runtime`. A server-queue runtime with no readable OpenCode
 * version stays available but `unverified` (the accepted deviation recorded in
 * `lib/consult/DOCUMENTATION.md`); a runtime whose connected OpenCode server
 * reports a real version at or above the verified floor is `verified`.
 *
 * F3 fail-closed: the mechanism was proven end-to-end on OpenCode 1.18.29.
 * The composer's live gate (`resolveConsultAvailability`) requires that
 * version, and an unreadable version refuses instead of assuming support.
 */
export type ConsultMechanismCapability =
  | { available: false; reason: 'unsupported-runtime' }
  | { available: false; reason: 'checking-version' }
  | { available: false; reason: 'version-unknown'; version?: string }
  | { available: false; reason: 'version-unsupported'; version?: string }
  | { available: true; assurance: 'unverified' }
  | { available: true; assurance: 'verified'; version: string };

export type ConsultMechanismCapabilityInput = {
  /** True when this runtime owns the message queue server-side. */
  serverQueueSupported: boolean;
};

/** The verified advisor mechanism for the current runtime/server. */
export const resolveConsultMechanismCapability = (
  input: ConsultMechanismCapabilityInput = { serverQueueSupported: isServerOwnedMessageQueue() },
): ConsultMechanismCapability => {
  if (!input.serverQueueSupported) return { available: false, reason: 'unsupported-runtime' };
  return { available: true, assurance: 'unverified' };
};

/**
 * The oldest OpenCode build the consult mechanism was verified on (Phase 0
 * probe, end-to-end). Anything below refuses; anything at or above passes.
 */
export const CONSULT_MIN_OPENCODE_VERSION = '1.18.29';

/** The version payload `GET /api/opencode/version` returns. */
export type ConsultServerVersionResponse = { version: string | null; error?: string };

export type ConsultServerVersionGate =
  | { verified: true; version: string }
  | { verified: false; reason: 'version-unknown'; version?: string }
  | { verified: false; reason: 'version-unsupported'; version?: string };

/**
 * Numeric-only semver-ish comparison. Prerelease suffixes (and build
 * metadata) are ignored deliberately: `1.19.0-beta` counts as 1.19.0, which
 * is at or above the floor. Comparing only the numeric fields keeps a
 * prerelease from being ordered below its own release and keeps the parse
 * total for any string the server hands over.
 */
/**
 * The semver-ish core of a version string: `v` prefix, prerelease suffix, and
 * build metadata are ignored, so `1.19.0-beta` reads as 1.19.0. Returns null
 * when the string has no `major[.minor[.patch]]` shape at all.
 */
const versionParts = (version: string): [number, number, number] | null => {
  const core = version.trim().replace(/^v/, '').split('+')[0].split('-')[0];
  if (!/^\d+(\.\d+){0,2}$/.test(core)) return null;
  const [major, minor = '0', patch = '0'] = core.split('.');
  const numeric = (value: string): number => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return [numeric(major), numeric(minor), numeric(patch)];
};

/** True when `candidate` is at or above `floor` (numeric fields only). */
export const isConsultVersionSupported = (candidate: string, floor: string = CONSULT_MIN_OPENCODE_VERSION): boolean => {
  const candidateParts = versionParts(candidate);
  if (!candidateParts) return false;
  const floorParts = versionParts(floor) ?? [0, 0, 0];
  if (candidateParts[0] !== floorParts[0]) return candidateParts[0] > floorParts[0];
  if (candidateParts[1] !== floorParts[1]) return candidateParts[1] > floorParts[1];
  return candidateParts[2] >= floorParts[2];
};

/**
 * The version half of the live gate, injectable for tests: an unreadable
 * version (`null`, empty, unparseable) or a fetch error is `version-unknown`
 * — fail closed, never assume the floor. A real version below the floor is
 * `version-unsupported`.
 */
export const verifyConsultServerVersion = async (
  fetchVersion: () => Promise<{ version: string | null; error?: string }>,
): Promise<ConsultServerVersionGate> => {
  let response: { version: string | null; error?: string };
  try {
    response = await fetchVersion();
  } catch {
    return { verified: false, reason: 'version-unknown' };
  }
  if (response.error) return { verified: false, reason: 'version-unknown' };
  const raw = response.version;
  if (!raw || !raw.trim()) return { verified: false, reason: 'version-unknown' };
  const version = raw.trim().replace(/^v/, '');
  // No semver-ish shape at all is unreadable, not merely old: a server that
  // reports a build string the parser cannot read is fail-closed unknown.
  if (!versionParts(version)) return { verified: false, reason: 'version-unknown', version };
  if (!isConsultVersionSupported(version)) return { verified: false, reason: 'version-unsupported', version };
  return { verified: true, version };
};

/** Short timeout for the live version read; the gate must not stall the composer. */
const CONSULT_VERSION_TIMEOUT_MS = 5_000;

/**
 * The version route's payload parsed at the I/O boundary with zod: the route
 * returns `{ version: string | null, error?: string }`; anything else reads
 * as unreadable.
 */
const serverVersionPayloadSchema = z.object({
  version: z.string().nullable(),
  error: z.string().optional(),
});

type ServerVersionPayload = z.infer<typeof serverVersionPayloadSchema>;

/** The live version read against the connected OpenChamber server. */
export const fetchConsultServerVersion = async (): Promise<ServerVersionPayload> => {
  try {
    const response = await runtimeFetch('/api/opencode/version', { signal: AbortSignal.timeout(CONSULT_VERSION_TIMEOUT_MS) });
    const payload = serverVersionPayloadSchema.safeParse(await response.json().catch(() => null));
    if (!response.ok) {
      return {
        version: null,
        error: payload.success ? payload.data.error : `version request failed (${response.status})`,
      };
    }
    return { version: payload.success ? payload.data.version : null };
  } catch (error) {
    return { version: null, error: error instanceof Error ? error.message : String(error) };
  }
};

/**
 * The composed live capability gate (F3): the runtime gate first, then the
 * connected server's OpenCode version. Unknown or unreadable versions refuse
 * (`version-unknown`), versions below the verified floor refuse
 * (`version-unsupported`), and only a verified version offers the action with
 * `assurance: 'verified'`.
 */
export const resolveConsultLiveCapability = async (
  fetchVersion: () => Promise<{ version: string | null; error?: string }> = fetchConsultServerVersion,
  input: ConsultMechanismCapabilityInput = { serverQueueSupported: isServerOwnedMessageQueue() },
): Promise<ConsultMechanismCapability> => {
  if (!input.serverQueueSupported) return { available: false, reason: 'unsupported-runtime' };
  const gate = await verifyConsultServerVersion(fetchVersion);
  if (gate.verified) return { available: true, assurance: 'verified', version: gate.version };
  return { available: false, reason: gate.reason, version: gate.version };
};