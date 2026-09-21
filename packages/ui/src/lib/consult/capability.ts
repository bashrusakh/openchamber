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
 * `unsupported-runtime`. Every other runtime is available but explicitly
 * `unverified` — offered under the accepted deviation recorded in
 * `lib/consult/DOCUMENTATION.md`, never because a signal confirmed it.
 *
 * A future `assurance: 'verified'` variant must not be added until a real
 * capability/version surface exists to produce it.
 */
export type ConsultMechanismCapability =
  | { available: false; reason: 'unsupported-runtime' }
  | { available: true; assurance: 'unverified' };

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
