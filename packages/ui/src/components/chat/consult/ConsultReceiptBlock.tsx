import React from 'react';
import type { TextPart } from '@opencode-ai/sdk/v2/client';

import { Icon } from '@/components/icon/Icon';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import type { I18nKey } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n';
import {
  parseConsultReceiptMetadata,
  type ConsultReceipt,
  type ConsultReceiptAdvisor,
} from '@/lib/consult/synthesis';
import { cn } from '@/lib/utils';
import { consultStatusLabelKey, consultStatusPresentation, formatConsultDuration } from './consultUi';

/**
 * The Consult Models receipt block (WP2.3).
 *
 * The receipt rides the acting user message's primary text part as bounded
 * metadata (`openchamberConsultReceipt`, written by `lib/consult/synthesis.ts`).
 * `ConsultReceiptFromPart` is the read boundary: it parses the metadata and
 * renders nothing for a missing or malformed receipt, so a foreign or edited
 * message can never break the timeline.
 *
 * The block is display-only. It never writes metadata, never re-runs the
 * consultation, and keeps no advisor text (plan D3).
 */

const RECEIPT_MODE_LABEL_KEYS = {
  parallel: 'chat.consult.dialog.mode.parallel',
  sequential: 'chat.consult.dialog.mode.sequential',
} satisfies Record<ConsultReceipt['mode'], I18nKey>;

const providerIdFromModelRef = (modelRef: string): string => {
  const slash = modelRef.indexOf('/');
  return slash > 0 ? modelRef.slice(0, slash) : modelRef;
};

const ConsultReceiptRow: React.FC<{ advisor: ConsultReceiptAdvisor }> = ({ advisor }) => {
  const { t } = useI18n();
  const status = consultStatusPresentation(advisor.status);
  const duration = formatConsultDuration(t, advisor.durationMs);
  const statusLabel = t(consultStatusLabelKey(advisor.status));

  return (
    <div className="flex min-w-0 items-center gap-1.5 typography-micro">
      <ProviderLogo providerId={providerIdFromModelRef(advisor.model)} className="h-3 w-3 flex-shrink-0" />
      <span className="min-w-0 flex-1 truncate text-foreground">{advisor.model}</span>
      {advisor.variant ? <span className="flex-shrink-0 text-muted-foreground">{advisor.variant}</span> : null}
      {duration ? <span className="flex-shrink-0 tabular-nums text-muted-foreground">{duration}</span> : null}
      <span className={cn('flex flex-shrink-0 items-center gap-1', status.className)}>
        <Icon name={status.icon} className="size-3" aria-hidden="true" />
        <span>{statusLabel}</span>
      </span>
      {advisor.reason ? (
        <span className="min-w-0 max-w-[40%] truncate text-muted-foreground" title={advisor.reason}>
          {advisor.reason}
        </span>
      ) : null}
    </div>
  );
};

const ConsultReceiptBlock: React.FC<{ receipt: ConsultReceipt }> = ({ receipt }) => {
  const { t } = useI18n();

  return (
    <div
      className="mt-2 rounded-md border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-2 py-1.5"
      data-consult-receipt={receipt.runID}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 typography-micro text-muted-foreground">
        <Icon name="team" className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">{t('chat.consult.receipt.title', { count: receipt.advisors.length })}</span>
        <span aria-hidden="true">·</span>
        <span>{t(RECEIPT_MODE_LABEL_KEYS[receipt.mode])}</span>
        <span aria-hidden="true">·</span>
        <span className="min-w-0 truncate">{t('chat.consult.receipt.acting', { model: receipt.acting })}</span>
      </div>
      {receipt.degraded ? (
        <div className="pt-1 typography-micro text-[var(--status-warning-text)]">
          {t('chat.consult.receipt.degraded')}
        </div>
      ) : null}
      <div className="flex flex-col gap-0.5 pt-1">
        {receipt.advisors.map((advisor, index) => (
          <ConsultReceiptRow key={`${advisor.model}-${index}`} advisor={advisor} />
        ))}
      </div>
    </div>
  );
};

/** Renders the receipt carried by a text part, or nothing when it has none. */
export const ConsultReceiptFromPart: React.FC<{ metadata: TextPart['metadata'] | null | undefined }> = ({ metadata }) => {
  const receipt = React.useMemo(() => parseConsultReceiptMetadata(metadata), [metadata]);
  if (!receipt) return null;
  return <ConsultReceiptBlock receipt={receipt} />;
};
