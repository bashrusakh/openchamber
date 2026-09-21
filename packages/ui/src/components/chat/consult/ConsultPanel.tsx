import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { ConsultAdvisorProgress, ConsultRunPhase, ConsultRunProgress } from '@/stores/useConsultStore';
import { ComposerFloatingPanel } from '../composer/ui/ComposerFloatingPanel';
import {
  consultRunReadyCount,
  consultStatusLabelKey,
  consultStatusPresentation,
  consultSummaryText,
  formatConsultDuration,
  isConsultRunCancellable,
  isConsultRunTerminal,
} from './consultUi';

/**
 * The Consult Models progress panel (WP2.3), docked above the composer like
 * `BtwPanel` and the queue chips.
 *
 * The panel renders `useConsultStore` only. It owns no run state: the phase
 * vocabulary and the per-advisor rows come from the store, the authoritative
 * queue admission is reflected by `waiting-admission`, and cancel/dispatch
 * ownership stays with the submission handle the composer holds.
 *
 * The store removes a record only on dismissal (`setPhase(..., 'idle')`), so a
 * finished run stays visible until the user dismisses it; `onDismiss` is that
 * write.
 */

const CONSULT_PHASE_LABEL_KEYS = {
  // A stored run is never `idle` (that phase removes the record); the entry
  // only keeps the map total.
  idle: 'chat.consult.panel.phase.cancelled',
  'waiting-admission': 'chat.consult.panel.phase.waitingAdmission',
  consulting: 'chat.consult.panel.phase.consulting',
  settling: 'chat.consult.panel.phase.settling',
  dispatching: 'chat.consult.panel.phase.dispatching',
  done: 'chat.consult.panel.phase.done',
  failed: 'chat.consult.panel.phase.failed',
  cancelled: 'chat.consult.panel.phase.cancelled',
} satisfies Record<ConsultRunPhase, I18nKey>;

const ConsultAdvisorRow: React.FC<{ advisor: ConsultAdvisorProgress }> = ({ advisor }) => {
  const { t } = useI18n();
  const status = consultStatusPresentation(advisor.status);
  const duration = formatConsultDuration(t, advisor.durationMs);
  const statusLabel = t(consultStatusLabelKey(advisor.status));

  return (
    <div className="flex min-w-0 items-center gap-2 py-0.5 typography-meta" data-consult-advisor={advisor.index}>
      <ProviderLogo providerId={advisor.providerID} className="h-3.5 w-3.5 flex-shrink-0" />
      <span className="min-w-0 flex-1 truncate text-foreground">
        {advisor.providerID}/{advisor.modelID}
      </span>
      {advisor.variant ? (
        <span className="flex-shrink-0 typography-micro text-muted-foreground">{advisor.variant}</span>
      ) : null}
      {duration ? (
        <span className="flex-shrink-0 tabular-nums text-muted-foreground">{duration}</span>
      ) : null}
      <span className={cn('flex flex-shrink-0 items-center gap-1', status.className)}>
        <Icon name={status.icon} className="size-3.5" aria-hidden="true" />
        <span className="typography-micro">{statusLabel}</span>
      </span>
      {advisor.reason ? (
        <span className="min-w-0 max-w-[40%] truncate text-muted-foreground" title={advisor.reason}>
          {advisor.reason}
        </span>
      ) : null}
    </div>
  );
};

export type ConsultPanelProps = {
  run: ConsultRunProgress;
  /** Cancel the run before dispatch; the submission releases the hold. */
  onCancel: () => void;
  /** Remove a finished run from the panel. */
  onDismiss: () => void;
};

export function ConsultPanel({ run, onCancel, onDismiss }: ConsultPanelProps) {
  const { t } = useI18n();
  const cancellable = isConsultRunCancellable(run.phase);
  const terminal = isConsultRunTerminal(run.phase);
  const phaseLabel = t(CONSULT_PHASE_LABEL_KEYS[run.phase], { count: run.advisors.length });
  // Working phases show the live aggregate; a terminal run replaces it with
  // the final segment summary (same labels the receipt uses).
  const readyCount = consultRunReadyCount(run.advisors);
  const summaryText = terminal ? consultSummaryText(t, run.advisors) : null;

  return (
    <ComposerFloatingPanel
      role="region"
      ariaLabel={t('chat.consult.panel.title')}
      header={(
        <>
          <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
            <Icon name="team" className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate typography-ui-label">{t('chat.consult.panel.title')}</span>
          </span>
          <span
            className="min-w-0 truncate typography-meta text-muted-foreground"
            data-consult-phase={run.phase}
            aria-live="polite"
          >
            {phaseLabel}
          </span>
          <div className="min-w-0 flex-1" />
          {cancellable ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-foreground"
              onClick={onCancel}
              aria-label={t('chat.consult.panel.cancel')}
              title={t('chat.consult.panel.cancel')}
            >
              <Icon name="close" className="size-4" aria-hidden="true" />
            </Button>
          ) : null}
          {terminal ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-foreground"
              onClick={onDismiss}
              aria-label={t('chat.consult.panel.dismiss')}
              title={t('chat.consult.panel.dismiss')}
            >
              <Icon name="close-circle" className="size-4" aria-hidden="true" />
            </Button>
          ) : null}
        </>
      )}
    >
      <div className="flex flex-col gap-0.5 px-3 pb-2">
        {terminal ? (
          summaryText ? (
            <div className="pb-1 typography-meta text-muted-foreground" data-consult-summary>
              {summaryText}
            </div>
          ) : null
        ) : (
          <div className="pb-1 typography-meta text-muted-foreground" data-consult-ready>
            {t('chat.consult.panel.ready', { ready: readyCount, total: run.advisors.length })}
          </div>
        )}
        {run.degraded ? (
          <div className="pb-1 typography-micro text-[var(--status-warning-text)]">
            {t('chat.consult.panel.degraded')}
          </div>
        ) : null}
        {run.error ? (
          <div className="pb-1 typography-micro text-[var(--status-error-text)]">{run.error}</div>
        ) : null}
        {run.advisors.map((advisor) => (
          <ConsultAdvisorRow key={advisor.index} advisor={advisor} />
        ))}
      </div>
    </ComposerFloatingPanel>
  );
}
