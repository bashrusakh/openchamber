/**
 * Writing a session export, from the Header and from the Sidebar.
 *
 * Both places open the same dialog and call the same function, so the
 * document they produce is the same document: the same sessions, the same
 * sub-agent transcripts, the same ordering. The Header and the Sidebar
 * differ only in where the export starts from.
 *
 * The export loads the session's own history and the history of every
 * descendant the app attaches to it, then hands them to the one pipeline. A
 * descendant that cannot be loaded is reported in the document and in a
 * toast; it never fails the export.
 *
 * Every session is read from the directory it runs in. A descendant that runs
 * in another directory lives in another session store, and the root's
 * directory would never find it.
 */

import * as React from 'react';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import {
  useGlobalSessionsStore,
  resolveGlobalSessionDirectory,
  ensureGlobalSessionsLoaded,
} from '@/stores/useGlobalSessionsStore';
import { useSessionMessageRecordsForExport } from '@/sync/use-sync';
import {
  buildExportFilename,
  downloadAsText,
  getExportRevealLabelKey,
  renderExportDocument,
  revealExportedMarkdown,
  saveAsMarkdownDesktop,
  type ExportFormat,
} from '@/lib/exportSession';
import { readExportSessions, type ExportRecordResult, type ExportSession } from '@/lib/export/collect';
import { buildExport } from '@/lib/export/pipeline';
import { useSessionExportDialog, type ExportChoice, type UseSessionExportDialog } from './useSessionExportDialog';

const MIME_TYPES = new Map<ExportFormat, string>([
  ['markdown', 'text/markdown'],
  ['html', 'text/html'],
  ['json', 'application/json'],
]);

const EXTENSIONS = new Map<ExportFormat, string>([
  ['markdown', 'md'],
  ['html', 'html'],
  ['json', 'json'],
]);

export type SessionExportTarget = {
  /** The session to export. */
  sessionID: string;
  /** The session's title, for the file name and the document's heading. */
  title: string | null | undefined;
  /** The directory the session runs in. */
  directory: string;
};

type UseSessionExport = UseSessionExportDialog & {
  /** Opens the export dialog for a session. */
  openExport: (target: SessionExportTarget) => void;
};

/**
 * The export's own state: the dialog, and the writing of the file.
 */
export const useSessionExport = (): UseSessionExport => {
  const { t } = useI18n();
  const loadRecords = useSessionMessageRecordsForExport();

  const writeExport = React.useCallback(async (
    target: SessionExportTarget,
    choice: ExportChoice,
  ): Promise<void> => {
    // The session list is read when the export runs, not while the row
    // renders: a sidebar holds a row per session, and every one of them
    // would otherwise follow the list.
    const initial = useGlobalSessionsStore.getState();
    let activeSessions = initial.activeSessions;
    let archivedSessions = initial.archivedSessions;
    // Whether the list is the whole list. The lineage lives in the list, so
    // an export that covers the sub-agent sessions needs the whole list: a
    // descendant whose page has not arrived yet is invisible to the walk,
    // and the document would come out short without saying so.
    let sessionListComplete = initial.hasLoaded;

    if (choice.includeSubagents && !sessionListComplete) {
      // The app's own load, shared with everything else that needs the
      // list. It resolves even when the load fails, and the export then
      // runs against a partial list and says so.
      await ensureGlobalSessionsLoaded().catch(() => undefined);
      const state = useGlobalSessionsStore.getState();
      // The list and the directories come from the list as it is after the
      // wait, not from the state the store happened to be in before it: a
      // descendant that arrives in a later page must be loadable from its
      // own directory, or it is reported missing for the wrong reason.
      activeSessions = state.activeSessions;
      archivedSessions = state.archivedSessions;
      sessionListComplete = state.hasLoaded;
    }

    const allSessions = readExportSessions([...activeSessions, ...archivedSessions]);
    const root = allSessions.find((session) => session.id === target.sessionID);

    // The directory each session runs in. A descendant that runs in another
    // directory lives in another session store, so the root's directory
    // would never find its records.
    const directoryBySessionID = new Map(
      [...activeSessions, ...archivedSessions].map((session) => [
        session.id,
        resolveGlobalSessionDirectory(session),
      ]),
    );

    // The root session the export starts from. The lineage below it is the
    // collector's business: it walks the session list and loads what the
    // user asked to be covered.
    const rootSession: ExportSession = {
      id: target.sessionID,
      title: target.title ?? 'Session',
      parentID: root?.parentID,
      agent: root?.agent,
      createdAt: root?.createdAt,
    };

    const load = async (sessionID: string): Promise<ExportRecordResult | null> => {
      // The exported session is read from the directory the export starts
      // from; every other session from the directory it runs in.
      const directory = sessionID === target.sessionID
        ? target.directory
        : (directoryBySessionID.get(sessionID) ?? target.directory);
      return loadRecords({ sessionID, directory }).catch(() => null);
    };

    const rootResult = await load(target.sessionID);
    if (!rootResult) {
      toast.error(t('sessions.sidebar.session.export.failedLoadHistory'));
      return;
    }
    // A staged revert can hide the whole conversation. The records the runtime
    // wrote are still there, so the session is not empty: the document names
    // the staged revert, and the JSON export keeps the records.
    const rootRecords = rootResult.sourceRecords ?? rootResult.records;
    if (rootRecords.length === 0) {
      toast.error(t('sessions.sidebar.session.export.nothingToExport'));
      return;
    }

    // The pipeline loads the descendants in waves and joins a call to the
    // child session it started. The Header and the Sidebar hand it the same
    // sessions, so both produce the same document.
    const result = await buildExport({
      root: rootSession,
      // The whole list, so the collector walks the lineage itself: the live
      // sessions the app attaches to this one, and no archived one. The
      // coverage choice reaches the collector: a user who does not want the
      // sub-agent transcripts gets a document without them, and without a
      // notice that they were left out.
      sessions: allSessions,
      load: async (sessionID) => {
        if (sessionID === target.sessionID) return rootResult;
        return load(sessionID);
      },
      includeSubagents: choice.includeSubagents,
      // The list was not the whole list, so the document says that the
      // sub-agent sessions that had not arrived yet are not in it.
      sessionListComplete,
    }, choice.mode);

    const document = renderExportDocument(result, choice.format, choice.mode, target.title);
    const findings = result.timeline.findings;
    const skipped = findings.filter((finding) => finding.kind === 'missing-session').length;

    const filename = buildExportFilename(target.title, EXTENSIONS.get(choice.format) ?? 'md');
    const savedPath = await saveAsMarkdownDesktop(document, filename, choice.format);
    if (!savedPath) {
      downloadAsText(document, filename, MIME_TYPES.get(choice.format) ?? 'text/plain');
    }

    toast.success(t('sessions.sidebar.session.export.success'), savedPath ? {
      action: {
        label: t(getExportRevealLabelKey()),
        onClick: () => {
          void revealExportedMarkdown(savedPath).then((revealed) => {
            if (!revealed) {
              toast.error(t('sessions.sidebar.session.export.failedRevealPath'));
            }
          });
        },
      },
    } : undefined);

    // The document names every sub-agent it could not load, and says so
    // once. The toast says the same thing to the person who asked.
    if (skipped > 0) {
      toast.warning(skipped === 1
        ? t('sessions.sidebar.session.export.skippedSubtaskSingle', { count: skipped })
        : t('sessions.sidebar.session.export.skippedSubtaskMany', { count: skipped }));
    }

    // The export says what it could not establish, and the person who asked
    // hears it too.
    if (findings.some((finding) => finding.kind === 'incomplete-session-list')) {
      toast.warning(t('sessions.sidebar.session.export.incompleteSessionList'));
    }
    if (findings.some((finding) => finding.kind === 'unreadable-inbox')) {
      toast.warning(t('sessions.sidebar.session.export.unreadableInbox'));
    }
  }, [loadRecords, t]);

  const dialog = useSessionExportDialog((target, choice) => {
    void writeExport(target, choice);
  });

  return { ...dialog, openExport: dialog.openDialog };
};
