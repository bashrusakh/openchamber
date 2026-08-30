import { getRuntimeKey } from '@/lib/runtime-switch';
import { useInlineCommentDraftStore, type InlineCommentDraft, type InlineCommentDraftTarget } from '@/stores/useInlineCommentDraftStore';
import type { MessageQueueTarget, QueuedMessagePart } from '@/stores/messageQueueStore';
import { useInputStore, type SyntheticContextPart } from '@/sync/input-store';
import { buildContextParts } from './buildOutgoingMessage';

export type ComposerContextSnapshot = {
    inlineComments: InlineCommentDraft[];
    syntheticParts: SyntheticContextPart[];
};

type ConsumedComposerContext = ComposerContextSnapshot & {
    restore: () => void;
};

const emptyContext = (): ComposerContextSnapshot => ({
    inlineComments: [],
    syntheticParts: [],
});

const targetDraft = (target: MessageQueueTarget): InlineCommentDraftTarget => ({
    directory: target.directory,
    sessionKey: target.sessionId,
});

/**
 * Claim the context that belongs to one direct send. A failed send can call
 * `restore` to return the same values without duplicating them. Queue callers
 * use `captureComposerContextForQueue` while creating their queue item so the
 * captured parts stay attached to that item.
 */
export const consumeComposerContext = (
    target: MessageQueueTarget | null,
    inlineDraftTarget: InlineCommentDraftTarget | null,
): ConsumedComposerContext => {
    const context = emptyContext();
    const canConsume = target === null || target.runtimeKey === getRuntimeKey();
    if (!canConsume) {
        return { ...context, restore: () => undefined };
    }

    context.syntheticParts = useInputStore.getState().consumePendingSyntheticParts(target ?? undefined) ?? [];
    context.inlineComments = inlineDraftTarget
        ? useInlineCommentDraftStore.getState().consumeDrafts(inlineDraftTarget)
        : [];

    let restored = false;
    const restore = () => {
        if (restored || (target !== null && target.runtimeKey !== getRuntimeKey())) return;
        restored = true;

        if (context.syntheticParts.length > 0) {
            useInputStore.getState().restorePendingSyntheticParts(context.syntheticParts, target ?? undefined);
        }
        if (context.inlineComments.length > 0 && inlineDraftTarget) {
            useInlineCommentDraftStore.getState().restoreDrafts(inlineDraftTarget, context.inlineComments);
        }
    };

    return { ...context, restore };
};

/** Run a direct send and restore all consumed context if the send rejects. */
export const withComposerContextRestore = async <T>(
    context: Pick<ConsumedComposerContext, 'restore'>,
    operation: () => Promise<T>,
): Promise<T> => {
    try {
        return await operation();
    } catch (error) {
        context.restore();
        throw error;
    }
};

export const queuedContextTarget = (target: MessageQueueTarget): InlineCommentDraftTarget => targetDraft(target);

/** Capture context as parts owned by one queue item instead of a target bucket. */
export const captureComposerContextForQueue = (
    target: MessageQueueTarget,
    inlineDraftTarget: InlineCommentDraftTarget | null,
): QueuedMessagePart[] => {
    const context = consumeComposerContext(target, inlineDraftTarget);
    return buildContextParts(context.inlineComments, context.syntheticParts);
};
