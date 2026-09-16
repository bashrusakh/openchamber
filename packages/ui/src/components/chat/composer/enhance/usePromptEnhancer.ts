/**
 * The composer's Enhance Prompt state machine: one generation counter, one
 * AbortController, and the protected-token gate between the Small Model's
 * rewrite and the draft it would replace.
 *
 * The hook owns everything ChatInput should not: request generations, stale
 * responses, cancellation, and validation. ChatInput only decides whether an
 * enhance may start, applies the returned text to the exact draft the request
 * was started from, and maps failure reasons to toasts.
 *
 * Stale responses (the user typed on, a second enhance started, the composer's
 * language context materially changed) are swallowed silently — a rewrite
 * answering after the draft moved on is not an error, it is nothing.
 *
 * "Materially changed" means the registry behind the language context changed
 * — compared by value via `sameLanguageContext`, not by object identity. The
 * composer rebuilds its context object on ordinary re-renders even when every
 * field is unchanged, so identity would wrongly discard every successful
 * response whenever React re-rendered between the click and the reply.
 */

import * as React from 'react';

import type { I18nKey } from '@/lib/i18n';

import {
    enhancePrompt,
    PromptEnhanceError,
    type PromptEnhanceContext,
    type PromptEnhanceFailure,
} from './promptEnhancer';
import { validateProtectedTokensPreserved } from './protectedTokens';
import type { ComposerLanguageContext } from '../language/tokenize';

export type PromptEnhanceResult =
    | { outcome: 'applied'; text: string; sourceSnapshot: string }
    | { outcome: 'stale' }
    | { outcome: 'failed'; reason: PromptEnhanceFailure };

/**
 * Failure reasons ChatInput maps to Enhance-specific toast copy. Reasons left
 * out already surface exactly one toast elsewhere: `provider-failed` is covered
 * by the request layer's generic Small Model notification, while `aborted` and
 * stale responses are silent by convention.
 */
export const ENHANCE_FAILURE_TOAST_KEYS = {
    unavailable: 'chat.chatInput.toast.enhanceUnavailable',
    'context-too-small': 'chat.chatInput.toast.enhanceContextTooSmall',
    'empty-result': 'chat.chatInput.toast.enhanceEmptyResult',
    'invalid-result': 'chat.chatInput.toast.enhanceInvalidResult',
    'timed-out': 'chat.chatInput.toast.enhanceTimedOut',
    // The reasons below surface exactly one toast elsewhere, or stay silent:
    // `provider-failed` is covered by the request layer's generic Small Model
    // notification; `aborted` and stale responses are silent by convention.
    'provider-failed': null,
    'aborted': null,
} as const satisfies Record<PromptEnhanceFailure, I18nKey | null>;

/**
 * Whether two language contexts carry the same workspace knowledge — the
 * registries the protected-token gate resolves against. Compared by value:
 * the composer rebuilds its context object on ordinary re-renders even when
 * nothing changed, so object identity cannot distinguish "the registry
 * changed" from "React re-rendered". Set members are already-normalized
 * (lowercased) strings, so plain equality is enough.
 */
function sameLanguageContext(
    a: ComposerLanguageContext,
    b: ComposerLanguageContext,
): boolean {
    if (a === b) return true;
    if (a.inputMode !== b.inputMode) return false;
    const setFields = [
        'knownAgentNames',
        'confirmedMentions',
        'knownSlashNames',
        'knownSnippetTriggers',
    ] as const;
    return setFields.every((field) => {
        const aSet = a[field];
        const bSet = b[field];
        if (aSet.size !== bSet.size) return false;
        for (const member of aSet) {
            if (!bSet.has(member)) return false;
        }
        return true;
    })
        && a.attachmentFilenames.length === b.attachmentFilenames.length
        && a.attachmentFilenames.every((name, index) => name === b.attachmentFilenames[index]);
}

export function usePromptEnhancer(languageContext: ComposerLanguageContext) {
    const [isEnhancing, setIsEnhancing] = React.useState(false);
    const pendingCountRef = React.useRef(0);
    // Monotonically increasing id of the latest request; any response from an
    // older generation is stale and must not touch anything.
    const generationRef = React.useRef(0);
    const abortRef = React.useRef<AbortController | null>(null);
    // Read through a ref so a registry change does not re-create the callback,
    // and a response is validated against the values the request was started
    // with (a materially changed context marks the response stale).
    const languageContextRef = React.useRef(languageContext);
    languageContextRef.current = languageContext;

    const settle = React.useCallback(() => {
        pendingCountRef.current = Math.max(0, pendingCountRef.current - 1);
        if (pendingCountRef.current === 0) setIsEnhancing(false);
    }, []);

    const cancel = React.useCallback(() => {
        abortRef.current?.abort();
    }, []);

    const enhance = React.useCallback(async (
        draft: string,
        context: PromptEnhanceContext,
    ): Promise<PromptEnhanceResult> => {
        const requestId = ++generationRef.current;
        // A newer request is the only authoritative one: abort whatever is
        // still in flight so it cannot land after this call.
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        const requestLanguageContext = languageContextRef.current;
        pendingCountRef.current += 1;
        setIsEnhancing(true);
        try {
            const cleaned = await enhancePrompt(draft, context, controller.signal);
            if (
                requestId !== generationRef.current
                || !sameLanguageContext(languageContextRef.current, requestLanguageContext)
            ) {
                return { outcome: 'stale' };
            }
            if (!validateProtectedTokensPreserved(draft, cleaned, requestLanguageContext)) {
                // Protected composer tokens were lost or invented: the draft
                // stays untouched and the failure is surfaced, not swallowed.
                return { outcome: 'failed', reason: 'invalid-result' };
            }
            return { outcome: 'applied', text: cleaned, sourceSnapshot: draft };
        } catch (error) {
            if (requestId !== generationRef.current) {
                return { outcome: 'stale' };
            }
            // Cancellation is the caller's decision, never an error to surface.
            // The abort may surface as a typed PromptEnhanceError('aborted')
            // (service layer) or as a raw DOMException AbortError (transport);
            // both names mean the same thing here.
            if (error instanceof PromptEnhanceError && error.reason === 'aborted') {
                return { outcome: 'stale' };
            }
            if (error instanceof Error && error.name === 'AbortError') {
                return { outcome: 'stale' };
            }
            const reason = error instanceof PromptEnhanceError ? error.reason : 'provider-failed';
            return { outcome: 'failed', reason };
        } finally {
            settle();
        }
    }, [settle]);

    React.useEffect(() => () => {
        // Unmount invalidates every in-flight request and stops its network work.
        generationRef.current += 1;
        abortRef.current?.abort();
    }, []);

    return { isEnhancing, enhance, cancel };
}
