import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { isServerOwnedMessageQueue } from '@/stores/messageQueueStore';

/**
 * Consult Models mechanism capability (plan risk 9 / WP0.4).
 *
 * The mechanism Phase 0 verified is: a turn-scoped `system` on the advisor
 * send, a wildcard deny-all session permission, a hidden advisor fork, and a
 * request body that survives the active runtime's transport (the web proxy
 * and the VS Code bridge).
 *
 * Two independent proofs are required, and the OpenCode version is not a
 * proxy for the backend half:
 *
 * - the connected OpenCode server reports a version at or above the build the
 *   mechanism was verified on (`CONSULT_MIN_OPENCODE_VERSION`);
 * - the connected OpenChamber backend speaks the consult queue protocol
 *   (`CONSULT_BACKEND_PROTOCOL_VERSION`), reported as `consultProtocol` on
 *   `GET /api/opencode/version`. A backend that predates that field ignores
 *   the unknown item `kind` and could deliver the message as a normal queued
 *   item, so an absent value must refuse instead of assuming support.
 *
 * The one real runtime signal is the server-owned message queue: admission is
 * impossible without it (VS Code has none), so a runtime without it is
 * `unsupported-runtime`. `resolveConsultMechanismCapability` is the
 * synchronous, still-unverified answer (the accepted deviation recorded in
 * `lib/consult/DOCUMENTATION.md`); the live gate
 * (`resolveConsultLiveCapability`) proves both requirements and refuses with
 * `version-unknown` / `version-unsupported` / `protocol-missing` /
 * `protocol-unsupported` when either is unreadable or missing.
 *
 * F3 fail-closed: the mechanism was proven end-to-end on OpenCode 1.18.29 and
 * against the backend protocol version this module requires; an unreadable
 * version or an absent/unusable backend protocol refuses instead of assuming
 * support.
 */
export type ConsultMechanismCapability =
  | { available: false; reason: 'unsupported-runtime' }
  | { available: false; reason: 'checking-version' }
  | { available: false; reason: 'version-unknown'; version?: string }
  | { available: false; reason: 'version-unsupported'; version?: string }
  | { available: false; reason: 'protocol-missing' }
  | { available: false; reason: 'protocol-unsupported' }
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

/**
 * The OpenChamber backend's consult-queue protocol version. This is
 * independent of the OpenCode version: the server that speaks the consult
 * queue reports it as `consultProtocol` on `GET /api/opencode/version`, and
 * the live gate refuses when that field is absent or below this value.
 */
export const CONSULT_BACKEND_PROTOCOL_VERSION = 1;

/** The version payload `GET /api/opencode/version` returns. */
export type ConsultServerVersionResponse = { version: string | null; error?: string; consultProtocol?: unknown };

export type ConsultServerVersionGate =
  | { verified: true; version: string }
  | { verified: false; reason: 'version-unknown'; version?: string }
  | { verified: false; reason: 'version-unsupported'; version?: string }
  | { verified: false; reason: 'protocol-missing' }
  | { verified: false; reason: 'protocol-unsupported'; protocol: number };

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
 * A usable backend protocol number is a non-negative integer; an absent, null,
 * string, float, or negative value reads as missing, never as a version.
 */
const consultBackendProtocolSchema = z.number().int().min(0);

/** Reads the consult-queue protocol the connected backend reports, if usable. */
const readConsultBackendProtocol = (value: ConsultServerVersionResponse['consultProtocol']): number | null => {
  const parsed = consultBackendProtocolSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/**
 * The live gate, injectable for tests: the OpenCode version **and** the
 * backend consult-queue protocol must both be proven, version first. An
 * unreadable version (`null`, empty, unparseable) or a fetch error is
 * `version-unknown`, and a real version below the floor is
 * `version-unsupported`. An absent or unusable `consultProtocol` is
 * `protocol-missing`, and one below `CONSULT_BACKEND_PROTOCOL_VERSION` is
 * `protocol-unsupported`; equal or higher passes (forward compatible). Every
 * refusal fails closed.
 */
export const verifyConsultServerVersion = async (
  fetchVersion: () => Promise<ConsultServerVersionResponse>,
): Promise<ConsultServerVersionGate> => {
  let response: ConsultServerVersionResponse;
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
  const protocol = readConsultBackendProtocol(response.consultProtocol);
  if (protocol === null) return { verified: false, reason: 'protocol-missing' };
  if (protocol < CONSULT_BACKEND_PROTOCOL_VERSION) return { verified: false, reason: 'protocol-unsupported', protocol };
  return { verified: true, version };
};

/** Short timeout for the live version read; the gate must not stall the composer. */
const CONSULT_VERSION_TIMEOUT_MS = 5_000;

/**
 * The version route's payload parsed at the I/O boundary with zod: the route
 * returns `{ version: string | null, error?: string, consultProtocol }`; the
 * protocol is kept as the raw value so the gate reads it instead of trusting
 * the parse to have understood it.
 */
const serverVersionPayloadSchema = z.object({
  version: z.string().nullable(),
  error: z.string().optional(),
  consultProtocol: z.unknown().optional(),
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
    if (!payload.success) return { version: null };
    return { version: payload.data.version, consultProtocol: payload.data.consultProtocol };
  } catch (error) {
    return { version: null, error: error instanceof Error ? error.message : String(error) };
  }
};

/**
 * The composed live capability gate (F3): the runtime gate first, then the
 * connected server's OpenCode version and backend consult-queue protocol.
 * Unknown or unreadable versions refuse (`version-unknown`), versions below
 * the verified floor refuse (`version-unsupported`), an absent or unusable
 * backend protocol refuses (`protocol-missing`), and one below
 * `CONSULT_BACKEND_PROTOCOL_VERSION` refuses (`protocol-unsupported`). Only
 * both proofs together offer the action with `assurance: 'verified'`.
 */
export const resolveConsultLiveCapability = async (
  fetchVersion: () => Promise<ConsultServerVersionResponse> = fetchConsultServerVersion,
  input: ConsultMechanismCapabilityInput = { serverQueueSupported: isServerOwnedMessageQueue() },
): Promise<ConsultMechanismCapability> => {
  if (!input.serverQueueSupported) return { available: false, reason: 'unsupported-runtime' };
  const gate = await verifyConsultServerVersion(fetchVersion);
  if (gate.verified) return { available: true, assurance: 'verified', version: gate.version };
  if (gate.reason === 'protocol-missing' || gate.reason === 'protocol-unsupported') {
    return { available: false, reason: gate.reason };
  }
  return { available: false, reason: gate.reason, version: gate.version };
};