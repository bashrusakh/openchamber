import type { Session } from '@opencode-ai/sdk/v2';
import { z } from 'zod';
import { getSessionMetadata, type SessionMetadataRecord } from '@/lib/sessionReviewMetadata';

/**
 * Session-metadata contract for Consult Models advisor forks, mirroring
 * `sessionBtwMetadata`:
 *
 * - Each advisor fork is marked `openchamber.kind = 'consult-advisor'` with
 *   the run id and, when the write carries them, the parent session id and
 *   the fork's index in the run. The marker is what keeps the temporary fork
 *   out of the normal session surfaces and lets cleanup find it; the readers
 *   require only the kind and the run id, the same contract the notification
 *   server suppresses on.
 * - The marker replaces the whole `openchamber` object. A fork clones the
 *   parent's metadata wholesale, so merging would inherit the parent's links
 *   (a `btwSessionID`, a previous run's marker) into the advisor session.
 * - Session metadata is persisted, externally writable data. Every read
 *   decodes it through the schemas below; no reader trusts a cast.
 */

const CONSULT_ADVISOR_KIND = 'consult-advisor';

/**
 * The read contract shared by every reader of the marker: the client's
 * hidden-session predicate, the GC, and the notification server's
 * suppression check. `kind` + `consultRunID` are what identify an advisor
 * fork; the parent id and the index ride along when present, but a partial
 * marker must hide, collect, and silence exactly the same session on every
 * side. The index is presentation data, so a malformed one never un-hides.
 */
const advisorLinkSchema = z.object({
  kind: z.literal(CONSULT_ADVISOR_KIND),
  consultRunID: z.string().trim().min(1),
  // A malformed optional parent id must not turn a hidden fork visible or
  // un-suppress it: the notification server ignores the field entirely, so a
  // link whose only flaw is the parent id still parses.
  originalSessionID: z.string().trim().min(1).optional().catch(undefined),
});

const advisorMarkerSchema = advisorLinkSchema.extend({
  originalSessionID: z.string().trim().min(1),
  advisorIndex: z.number().int().min(0),
});

type ConsultAdvisorLink = z.infer<typeof advisorLinkSchema>;

/** The fields an advisor fork is marked with, before the kind is added. */
export type ConsultAdvisorMarkerInput = {
  originalSessionID: string;
  consultRunID: string;
  advisorIndex: number;
};

const parseAdvisorLink = (metadata: SessionMetadataRecord): ConsultAdvisorLink | null => {
  const parsed = advisorLinkSchema.safeParse(metadata.openchamber);
  return parsed.success ? parsed.data : null;
};

/**
 * The session is an advisor fork of the Consult Models flow.
 *
 * Only the kind and the run id are required: they are the marker contract the
 * notification server suppresses on, and they are what the GC needs. A marker
 * missing either is not an advisor fork anywhere.
 */
export const isConsultAdvisorSession = (session: Session | null | undefined): boolean =>
  parseAdvisorLink(getSessionMetadata(session)) !== null;

/** The parent session the advisor forked from, or null. */
export const getConsultOriginalSessionID = (session: Session | null | undefined): string | null => {
  const link = parseAdvisorLink(getSessionMetadata(session));
  return link === null ? null : link.originalSessionID ?? null;
};

/** The consultation run the fork belongs to, or null. */
export const getConsultRunID = (session: Session | null | undefined): string | null => {
  const link = parseAdvisorLink(getSessionMetadata(session));
  return link === null ? null : link.consultRunID;
};

/**
 * Mark a fork as an advisor of a run. The inherited `openchamber` object is
 * replaced, never merged (see the module comment).
 *
 * The marker is validated before it is written, so a marker the readers
 * cannot recognize can never reach session metadata: invalid input throws.
 */
export const withConsultAdvisorMarker = (
  metadata: SessionMetadataRecord,
  input: ConsultAdvisorMarkerInput,
): SessionMetadataRecord => ({
  ...metadata,
  openchamber: advisorMarkerSchema.parse({
    kind: CONSULT_ADVISOR_KIND,
    originalSessionID: input.originalSessionID,
    consultRunID: input.consultRunID,
    advisorIndex: input.advisorIndex,
  }),
});
