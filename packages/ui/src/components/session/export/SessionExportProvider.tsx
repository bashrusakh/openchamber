/* oxlint-disable react/only-export-components -- Provider and hooks are one contract. */
/**
 * The app's one export dialog.
 *
 * The Header and the Sidebar both open the same export, so the dialog lives
 * above the two of them: it holds the format, the detail level and the
 * coverage the reader chose, and the opener it hands down is the same
 * function in both places.
 *
 * The coverage belongs to the session it was made for, and it outlives the
 * row it was made from. The sidebar virtualizes its rows, and a row that
 * scrolls out of the window is unmounted, so a choice kept in the row would
 * die with it.
 */

import * as React from 'react';
import { useSessionExport, type SessionExportTarget } from './useSessionExport';

type SessionExportContextValue = {
  /** Opens the export dialog for a session. */
  openExport: (target: SessionExportTarget) => void;
};

const SessionExportContext = React.createContext<SessionExportContextValue | null>(null);

/**
 * The export dialog, and the opener that opens it.
 *
 * The opener's identity does not change when the dialog's own state does, so
 * a sidebar row does not re-render when the reader touches the dialog.
 */
export const SessionExportProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { dialog, openExport } = useSessionExport();
  const value = React.useMemo(() => ({ openExport }), [openExport]);
  return (
    <SessionExportContext.Provider value={value}>
      {dialog}
      {children}
    </SessionExportContext.Provider>
  );
};

/**
 * Opens the export dialog for a session.
 *
 * A consumer outside the provider has no dialog to open, so it fails loudly
 * rather than doing nothing.
 */
export const useSessionExportOpener = (): ((target: SessionExportTarget) => void) => {
  const context = React.useContext(SessionExportContext);
  if (!context) {
    throw new Error('useSessionExportOpener must be used within <SessionExportProvider>');
  }
  return context.openExport;
};
