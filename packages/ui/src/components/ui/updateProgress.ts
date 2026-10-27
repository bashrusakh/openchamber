import type { UpdateProgress } from '@/lib/desktop';

/**
 * Desktop download percentage for the update dialog, clamped to 0-100.
 * electron-updater can report transferred bytes above `total` (differential
 * downloads on macOS transfer more than the zip size), so the raw ratio is
 * capped the same way the Windows taskbar progress is.
 */
export const updateProgressPercent = (progress: UpdateProgress | null | undefined): number => {
  if (!progress?.total) return 0;
  const percent = Math.round((progress.downloaded / progress.total) * 100);
  return Math.min(100, Math.max(0, percent));
};
