import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { CONSULT_MIN_OPENCODE_VERSION } from '@/lib/consult/capability';
import { cn } from '@/lib/utils';
import { consultUnavailableLabelKey, type ConsultUnavailableReason } from './consultUi';

/**
 * The composer's Consult Models action.
 *
 * A disabled button swallows pointer events, so the tooltip trigger wraps it
 * in a span; the unavailable reason is therefore reachable even though the
 * control cannot be pressed. The same reason is part of the accessible name,
 * so the state is not explained by hover alone.
 */

type ConsultActionButtonProps = {
  footerIconButtonClass: string;
  iconSizeClass: string;
  onOpenConsult: () => void;
  /** Null while the action is available; otherwise why it is not. */
  unavailableReason: ConsultUnavailableReason | null;
};

export const ConsultActionButton = React.memo(function ConsultActionButton({
  footerIconButtonClass,
  iconSizeClass,
  onOpenConsult,
  unavailableReason,
}: ConsultActionButtonProps) {
  const { t } = useI18n();
  // Both version reasons name the floor; the tooltip reads the same floor the
  // live gate verified against.
  const unavailableLabel = unavailableReason
    ? t(consultUnavailableLabelKey(unavailableReason), { version: CONSULT_MIN_OPENCODE_VERSION, minVersion: CONSULT_MIN_OPENCODE_VERSION })
    : null;
  const actionLabel = t('chat.consult.action');

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex flex-shrink-0">
          <button
            type="button"
            className={cn(
              footerIconButtonClass,
              'rounded-md hover:bg-transparent',
              unavailableReason && 'opacity-30',
            )}
            onClick={onOpenConsult}
            disabled={unavailableReason !== null}
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onPointerDownCapture={(event) => {
              if (event.pointerType === 'touch') {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
            aria-label={unavailableLabel ? `${actionLabel} — ${unavailableLabel}` : actionLabel}
          >
            <Icon name="team" className={cn(iconSizeClass, 'text-current')} />
          </button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={8}>
        {unavailableLabel ?? t('chat.consult.action.hint')}
      </TooltipContent>
    </Tooltip>
  );
});
