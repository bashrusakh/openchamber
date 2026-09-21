import React from 'react';

import { Icon } from '@/components/icon/Icon';
import {
  ModelMultiSelect,
  type ModelSelectionWithId,
} from '@/components/multirun/ModelMultiSelect';
import { Button } from '@/components/ui/button';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { ConsultAdvisorSelection } from '@/lib/consult/routing';
import {
  submitConsultMessage,
  type ConsultSubmissionHandle,
  type SubmitConsultMessageInput,
} from '@/lib/consult/submission';
import { useI18n } from '@/lib/i18n';
import { getProviderModelDisplayName } from '@/lib/modelDisplay';
import type { ConsultRunMode } from '@/stores/useConsultStore';
import { useConfigStore } from '@/stores/useConfigStore';
import {
  CONSULT_ADVISOR_MAX,
  CONSULT_ADVISOR_MIN,
  CONSULT_TIMEOUT_PRESETS,
  DEFAULT_CONSULT_TIMEOUT_MS,
  type ConsultSubmissionCapture,
} from './consultUi';

/**
 * The Consult Models advisor picker (WP2.2).
 *
 * The dialog owns only the per-run options (advisors, mode, timeout). The
 * message itself stays with the composer: `captureSubmission` returns the
 * payload exactly as the composer captured it at confirm time, and the dialog
 * hands the whole thing to `submitConsultMessage` so the queue admission and
 * the advisor fan-out keep one owner (`lib/consult/submission.ts`).
 *
 * The acting model is read-only: the session's own selection is what will
 * write the reply, and the dialog never changes it.
 */

export type ConsultActingSelection = {
  providerID: string | null;
  modelID: string | null;
  variant?: string;
};

export type ConsultModelsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Read-only acting selection, shown from the session. */
  acting: ConsultActingSelection;
  /** Primary agent every advisor runs under; null disables the confirm. */
  advisorAgent: string | null;
  /** Captures the composer payload at confirm time; null aborts the submit. */
  captureSubmission: () => Promise<ConsultSubmissionCapture | null>;
  /**
   * Receives the live handle so the composer can show progress and cancel,
   * plus the exact advisor selections so a later refusal can name the rejected
   * rows.
   */
  onSubmitted: (
    handle: ConsultSubmissionHandle,
    advisors: readonly ConsultAdvisorSelection[],
  ) => void;
  /** Injectable for tests; the live submission entry point by default. */
  submit?: (input: SubmitConsultMessageInput) => ConsultSubmissionHandle;
};

export function ConsultModelsDialog({
  open,
  onOpenChange,
  acting,
  advisorAgent,
  captureSubmission,
  onSubmitted,
  submit = submitConsultMessage,
}: ConsultModelsDialogProps) {
  const { t } = useI18n();
  const providers = useConfigStore((state) => state.providers);

  const [selectedModels, setSelectedModels] = React.useState<ModelSelectionWithId[]>([]);
  const [mode, setMode] = React.useState<ConsultRunMode>('parallel');
  const [timeoutMs, setTimeoutMs] = React.useState(DEFAULT_CONSULT_TIMEOUT_MS);
  const [submitting, setSubmitting] = React.useState(false);

  const actingProvider = providers.find((provider) => provider.id === acting.providerID);
  const actingLabel = getProviderModelDisplayName(actingProvider, acting.modelID, {
    fallbackLabel: acting.providerID && acting.modelID ? `${acting.providerID}/${acting.modelID}` : '',
  });

  const handleAddModel = React.useCallback((model: ModelSelectionWithId) => {
    setSelectedModels((current) => [...current, model]);
  }, []);

  const handleRemoveModel = React.useCallback((index: number) => {
    setSelectedModels((current) => current.filter((_, position) => position !== index));
  }, []);

  const handleUpdateModel = React.useCallback((index: number, model: ModelSelectionWithId) => {
    setSelectedModels((current) => current.map((entry, position) => (position === index ? model : entry)));
  }, []);

  const canConfirm = advisorAgent !== null
    && selectedModels.length >= CONSULT_ADVISOR_MIN
    && !submitting;

  const handleConfirm = React.useCallback(async () => {
    if (!canConfirm || !advisorAgent) return;
    setSubmitting(true);
    try {
      const capture = await captureSubmission();
      if (!capture) {
        onOpenChange(false);
        return;
      }
      const advisors: ConsultAdvisorSelection[] = selectedModels.map((model) => {
        const selection: ConsultAdvisorSelection = {
          providerID: model.providerID,
          modelID: model.modelID,
          agent: advisorAgent,
        };
        if (model.variant) selection.variant = model.variant;
        return selection;
      });
      const handle = submit({ ...capture, advisors, mode, timeoutMs });
      // The next consult starts from an empty picker; this run's options are
      // now owned by the submission.
      setSelectedModels([]);
      onSubmitted(handle, advisors);
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  }, [advisorAgent, canConfirm, captureSubmission, mode, onOpenChange, onSubmitted, selectedModels, submit, timeoutMs]);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!submitting) onOpenChange(nextOpen); }}>
      <DialogContent className="max-w-lg overflow-visible">
        <DialogHeader>
          <DialogTitle>{t('chat.consult.dialog.title')}</DialogTitle>
          <DialogDescription>{t('chat.consult.dialog.description')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="typography-meta font-medium text-muted-foreground">
              {t('chat.consult.dialog.actingLabel')}
            </span>
            <div className="flex min-w-0 items-center gap-2 rounded-md border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-2.5 py-1.5">
              {acting.providerID ? (
                <ProviderLogo providerId={acting.providerID} className="h-4 w-4 flex-shrink-0" />
              ) : null}
              <span className="min-w-0 truncate typography-ui-label text-foreground">{actingLabel}</span>
              {acting.variant ? (
                <span className="flex-shrink-0 typography-micro text-muted-foreground">{acting.variant}</span>
              ) : null}
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="typography-meta font-medium text-muted-foreground">
              {t('chat.consult.dialog.advisorsLabel')}
            </span>
            <ModelMultiSelect
              selectedModels={selectedModels}
              onAdd={handleAddModel}
              onRemove={handleRemoveModel}
              onUpdate={handleUpdateModel}
              minModels={CONSULT_ADVISOR_MIN}
              maxModels={CONSULT_ADVISOR_MAX}
              addButtonClassName="w-fit"
              dropdownSide="bottom"
              dropdownClassName="w-[min(26rem,calc(100vw-4rem))]"
            />
            {advisorAgent === null ? (
              <p className="typography-micro text-[var(--status-warning-text)]">
                {t('chat.consult.dialog.noAdvisorAgent')}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="typography-meta font-medium text-muted-foreground">
              {t('chat.consult.dialog.modeLabel')}
            </span>
            <div className="flex items-center gap-1.5" role="group" aria-label={t('chat.consult.dialog.modeLabel')}>
              <Button
                type="button"
                variant="chip"
                size="sm"
                aria-pressed={mode === 'parallel'}
                onClick={() => setMode('parallel')}
                disabled={submitting}
              >
                {t('chat.consult.dialog.mode.parallel')}
              </Button>
              <Button
                type="button"
                variant="chip"
                size="sm"
                aria-pressed={mode === 'sequential'}
                onClick={() => setMode('sequential')}
                disabled={submitting}
              >
                {t('chat.consult.dialog.mode.sequential')}
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="typography-meta font-medium text-muted-foreground">
              {t('chat.consult.dialog.timeoutLabel')}
            </span>
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('chat.consult.dialog.timeoutLabel')}>
              {CONSULT_TIMEOUT_PRESETS.map((preset) => (
                <Button
                  key={preset.timeoutMs}
                  type="button"
                  variant="chip"
                  size="sm"
                  aria-pressed={timeoutMs === preset.timeoutMs}
                  onClick={() => setTimeoutMs(preset.timeoutMs)}
                  disabled={submitting}
                >
                  {t(preset.labelKey)}
                </Button>
              ))}
            </div>
          </div>

          <p className="typography-meta text-muted-foreground">{t('chat.consult.dialog.privacy')}</p>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('chat.consult.dialog.actions.cancel')}
          </Button>
          <Button size="sm" onClick={() => void handleConfirm()} disabled={!canConfirm}>
            <Icon name="team" className="size-3.5" />
            {submitting ? t('chat.consult.dialog.actions.submitting') : t('chat.consult.dialog.actions.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
