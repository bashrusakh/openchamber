import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';
import type { AttachedFile } from './types/sessionTypes';
import { updateDesktopSettings } from '@/lib/persistence';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { normalizePath } from '@/lib/pathNormalization';
import type { ContextPartMetadata } from '@/lib/messages/contextParts';

export type FollowUpBehavior = 'steer' | 'queue';

type PersistedFollowUpBehavior = FollowUpBehavior | 'immediate' | null | undefined;

export const DEFAULT_FOLLOW_UP_BEHAVIOR: FollowUpBehavior = 'queue';

type MainSessionSendIntent = 'composer' | 'queued';
type MainSessionSendDisposition = 'send' | 'queue' | 'preserve-queued';

type MessageQueueDispatchState = {
    head: QueuedMessage | null;
    sendingIds: string[];
};

export const resolveMainSessionSendDisposition = (input: {
    intent: MainSessionSendIntent;
    hasMainSession: boolean;
    isBtwActive: boolean;
    isBusy: boolean;
    canQueue: boolean;
    hasQueuedMessageInFlight?: boolean;
}): MainSessionSendDisposition => {
    if (!input.hasMainSession || input.isBtwActive) {
        return 'send';
    }

    // An unresolved queue send owns this target. Queue normal composer input
    // when possible; otherwise preserve it rather than allowing a different
    // input mode to merge later queue items into a direct request.
    if (input.hasQueuedMessageInFlight) {
        if (input.intent === 'queued' || !input.canQueue) return 'preserve-queued';
        return 'queue';
    }

    if (!input.isBusy || !input.canQueue) return 'send';

    return input.intent === 'queued' ? 'preserve-queued' : 'queue';
};

export const normalizeFollowUpBehavior = (
    value: PersistedFollowUpBehavior,
    legacyQueueModeEnabled?: boolean | null,
): FollowUpBehavior => {
    // Keep accepting the old values at the persistence boundary, but the
    // queue-only hotfix has no direct-send or steer behavior to select.
    void value;
    void legacyQueueModeEnabled;
    return DEFAULT_FOLLOW_UP_BEHAVIOR;
};

export interface QueuedMessage {
    id: string;
    content: string;
    attachments?: AttachedFile[];
    additionalParts?: QueuedMessagePart[];
    /** Context was captured when this item was queued and is stored on the item. Omitted on legacy entries. */
    contextClaimed?: boolean;
    createdAt: number;
    /** Send config captured at queue time — used as-is when auto-sending */
    sendConfig?: {
        providerID: string;
        modelID: string;
        agent?: string;
        variant?: string;
    };
}

export type QueuedMessagePart = {
    text: string;
    attachments?: AttachedFile[];
    synthetic?: boolean;
    metadata?: ContextPartMetadata;
};

export type MessageQueueTarget = {
    runtimeKey: string;
    directory: string;
    sessionId: string;
};

const MAX_QUEUE_TARGETS = 50;
const MAX_MESSAGES_PER_QUEUE = 20;

export const createMessageQueueTarget = (
    sessionId: string,
    directory: string | null | undefined,
    runtimeKey: string = getRuntimeKey(),
): MessageQueueTarget | null => {
    const normalizedDirectory = normalizePath(directory);
    if (!runtimeKey || !normalizedDirectory || !sessionId) return null;
    return { runtimeKey, directory: normalizedDirectory, sessionId };
};

export const getMessageQueueKey = (target: MessageQueueTarget): string =>
    `${target.runtimeKey}\n${target.directory}\n${target.sessionId}`;

export const isQueueMessageDispatchable = (
    queue: QueuedMessage[],
    sendingIds: string[],
    messageId: string,
): boolean => sendingIds.length === 0 && queue[0]?.id === messageId;

export const isQueueMessageInFlight = (sendingIds: string[], messageId: string): boolean =>
    sendingIds.includes(messageId);

export const parseMessageQueueKey = (key: string): MessageQueueTarget | null => {
    const [runtimeKey, directory, ...sessionParts] = key.split('\n');
    return createMessageQueueTarget(sessionParts.join('\n'), directory, runtimeKey);
};

interface MessageQueueState {
    queuedMessages: Record<string, QueuedMessage[]>; // runtime + directory + session → queue
    quarantinedLegacyMessages: Record<string, QueuedMessage[]>;
    followUpBehavior: FollowUpBehavior;
    /**
     * Queued messages whose send is currently awaiting the server, per target.
     *
     * A queued item is removed only after its send resolves, so between
     * dispatch and resolution it is still visible to every other reader — and
     * a composer submit merges the whole queue into its own send. Over a relay
     * that window is seconds, long enough for the same message to be delivered
     * twice. While any entry is listed here, no later entry is sendable.
     *
     * Never persisted: a restart has no in-flight sends, and a stale flag would
     * strand a queued message permanently.
     */
    sendingIds: Record<string, string[]>;
}

interface MessageQueueActions {
    addToQueue: (target: MessageQueueTarget, message: Omit<QueuedMessage, 'id' | 'createdAt'>) => void;
    removeFromQueue: (target: MessageQueueTarget, messageId: string) => void;
    reorderQueue: (target: MessageQueueTarget, fromId: string, toId: string) => void;
    popToInput: (target: MessageQueueTarget, messageId: string) => QueuedMessage | null;
    clearQueue: (target: MessageQueueTarget) => void;
    clearAllQueues: () => void;
    markSending: (target: MessageQueueTarget, messageId: string) => boolean;
    clearSending: (target: MessageQueueTarget, messageId: string) => void;
    completeSending: (target: MessageQueueTarget, messageId: string) => void;
    getSendableQueue: (target: MessageQueueTarget) => QueuedMessage[];
    getQueueDispatchState: (target: MessageQueueTarget) => MessageQueueDispatchState;
    setFollowUpBehavior: (behavior: FollowUpBehavior) => void;
    getQueueForTarget: (target: MessageQueueTarget) => QueuedMessage[];
}

type MessageQueueStore = MessageQueueState & MessageQueueActions;

type PersistedMessageQueueState = {
    queuedMessages?: Record<string, QueuedMessage[]>;
    quarantinedLegacyMessages?: Record<string, QueuedMessage[]>;
    followUpBehavior?: FollowUpBehavior;
    queueModeEnabled?: boolean;
};

export const migrateMessageQueueState = (persistedState: unknown, version: number): Partial<MessageQueueStore> => {
    const state = (persistedState ?? {}) as PersistedMessageQueueState;
    const legacyQueues = version < 2 ? (state.queuedMessages ?? {}) : {};
    return {
        queuedMessages: version < 2 ? {} : (state.queuedMessages ?? {}),
        quarantinedLegacyMessages: {
            ...(state.quarantinedLegacyMessages ?? {}),
            ...legacyQueues,
        },
        followUpBehavior: normalizeFollowUpBehavior(state.followUpBehavior, state.queueModeEnabled ?? null),
    };
};

export const useMessageQueueStore = create<MessageQueueStore>()(
    devtools(
        persist(
            (set, get) => ({
                queuedMessages: {},
                quarantinedLegacyMessages: {},
                followUpBehavior: DEFAULT_FOLLOW_UP_BEHAVIOR,
                sendingIds: {},

                addToQueue: (target, message) => {
                    const key = getMessageQueueKey(target);
                    const id = `queued-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
                    const queuedMessage: QueuedMessage = {
                        id,
                        content: message.content,
                        attachments: message.attachments,
                        additionalParts: message.additionalParts,
                        contextClaimed: message.contextClaimed,
                        createdAt: Date.now(),
                        sendConfig: message.sendConfig,
                    };

                    set((state) => {
                        const currentQueue = state.queuedMessages[key] ?? [];
                        const nextQueue = [...currentQueue, queuedMessage];
                        const sendingIds = new Set(state.sendingIds[key] ?? []);
                        const overflow = Math.max(0, nextQueue.length - MAX_MESSAGES_PER_QUEUE);
                        const droppedIds = new Set(
                            nextQueue
                                .filter((item) => !sendingIds.has(item.id))
                                .slice(0, overflow)
                                .map((item) => item.id),
                        );
                        const queuedMessages = {
                            ...state.queuedMessages,
                            [key]: nextQueue.filter((item) => !droppedIds.has(item.id)),
                        };
                        const keys = Object.keys(queuedMessages);
                        if (keys.length > MAX_QUEUE_TARGETS) {
                            keys.sort((left, right) => (
                                (queuedMessages[left]?.[0]?.createdAt ?? 0) - (queuedMessages[right]?.[0]?.createdAt ?? 0)
                            ));
                            for (const staleKey of keys.slice(0, keys.length - MAX_QUEUE_TARGETS)) delete queuedMessages[staleKey];
                        }
                        return {
                            queuedMessages,
                        };
                    });
                },

                removeFromQueue: (target, messageId) => {
                    const key = getMessageQueueKey(target);
                    set((state) => {
                        if (isQueueMessageInFlight(state.sendingIds[key] ?? [], messageId)) return state;
                        const currentQueue = state.queuedMessages[key] ?? [];
                        const newQueue = currentQueue.filter((m) => m.id !== messageId);
                        
                        if (newQueue.length === 0) {
                            const { [key]: _removed, ...rest } = state.queuedMessages;
                            void _removed;
                            return { queuedMessages: rest };
                        }
                        
                        return {
                            queuedMessages: {
                                ...state.queuedMessages,
                                [key]: newQueue,
                            },
                        };
                    });
                },

                reorderQueue: (target, fromId, toId) => {
                    if (fromId === toId) return;
                    const key = getMessageQueueKey(target);
                    set((state) => {
                        const currentQueue = state.queuedMessages[key];
                        if (!currentQueue) return state;
                        // Keep an in-flight head ahead of every later item. A
                        // reorder during its unresolved request must not let a
                        // later item overtake it if the request fails.
                        if ((state.sendingIds[key] ?? []).length > 0) return state;
                        const fromIndex = currentQueue.findIndex((m) => m.id === fromId);
                        const toIndex = currentQueue.findIndex((m) => m.id === toId);
                        if (fromIndex === -1 || toIndex === -1) return state;

                        const newQueue = currentQueue.slice();
                        const [moved] = newQueue.splice(fromIndex, 1);
                        newQueue.splice(toIndex, 0, moved);

                        return {
                            queuedMessages: {
                                ...state.queuedMessages,
                                [key]: newQueue,
                            },
                        };
                    });
                },

                popToInput: (target, messageId) => {
                    const key = getMessageQueueKey(target);
                    let message: QueuedMessage | null = null;
                    set((prevState) => {
                        if (isQueueMessageInFlight(prevState.sendingIds[key] ?? [], messageId)) return prevState;
                        const queue = prevState.queuedMessages[key] ?? [];
                        message = queue.find((m) => m.id === messageId) ?? null;
                        if (!message) return prevState;
                        const newQueue = queue.filter((m) => m.id !== messageId);
                        
                        if (newQueue.length === 0) {
                            const { [key]: _removed, ...rest } = prevState.queuedMessages;
                            void _removed;
                            return { queuedMessages: rest };
                        }
                        
                        return {
                            queuedMessages: {
                                ...prevState.queuedMessages,
                                [key]: newQueue,
                            },
                        };
                    });

                    return message;
                },

                clearQueue: (target) => {
                    const key = getMessageQueueKey(target);
                    set((state) => {
                        // Clearing drops what is still queued, never a message
                        // already handed to the server: that send will resolve
                        // and must find its entry to remove or restore.
                        const sending = state.sendingIds[key] ?? [];
                        const retained = (state.queuedMessages[key] ?? []).filter((m) => sending.includes(m.id));
                        if (retained.length > 0) {
                            return { queuedMessages: { ...state.queuedMessages, [key]: retained } };
                        }
                        const { [key]: _removed, ...rest } = state.queuedMessages;
                        void _removed;
                        return { queuedMessages: rest };
                    });
                },

                clearAllQueues: () => {
                    set((state) => {
                        const queuedMessages: Record<string, QueuedMessage[]> = {};
                        for (const [key, sending] of Object.entries(state.sendingIds)) {
                            const retained = (state.queuedMessages[key] ?? [])
                                .filter((message) => sending.includes(message.id));
                            if (retained.length > 0) queuedMessages[key] = retained;
                        }
                        return { queuedMessages };
                    });
                },

                markSending: (target, messageId) => {
                    const key = getMessageQueueKey(target);
                    let claimed = false;
                    set((state) => {
                        const current = state.sendingIds[key] ?? [];
                        const queue = state.queuedMessages[key] ?? [];
                        if (!isQueueMessageDispatchable(queue, current, messageId)) return state;
                        claimed = true;
                        return { sendingIds: { ...state.sendingIds, [key]: [...current, messageId] } };
                    });
                    return claimed;
                },

                clearSending: (target, messageId) => {
                    const key = getMessageQueueKey(target);
                    set((state) => {
                        const current = state.sendingIds[key];
                        if (!current || !current.includes(messageId)) return state;
                        const next = current.filter((id) => id !== messageId);
                        if (next.length === 0) {
                            const { [key]: _removed, ...rest } = state.sendingIds;
                            void _removed;
                            return { sendingIds: rest };
                        }
                        return { sendingIds: { ...state.sendingIds, [key]: next } };
                    });
                },

                completeSending: (target, messageId) => {
                    const key = getMessageQueueKey(target);
                    set((state) => {
                        const currentSending = state.sendingIds[key] ?? [];
                        if (!isQueueMessageInFlight(currentSending, messageId)) return state;

                        const currentQueue = state.queuedMessages[key] ?? [];
                        const nextQueue = currentQueue.filter((message) => message.id !== messageId);
                        const nextSending = currentSending.filter((id) => id !== messageId);
                        const queuedMessages = { ...state.queuedMessages };
                        const sendingIds = { ...state.sendingIds };

                        if (nextQueue.length === 0) delete queuedMessages[key];
                        else queuedMessages[key] = nextQueue;
                        if (nextSending.length === 0) delete sendingIds[key];
                        else sendingIds[key] = nextSending;

                        return { queuedMessages, sendingIds };
                    });
                },

                getSendableQueue: (target) => {
                    const key = getMessageQueueKey(target);
                    const state = get();
                    const queue = state.queuedMessages[key] ?? [];
                    const sending = state.sendingIds[key];
                    // The in-flight head stays visible until its request
                    // resolves, so no later item is sendable in the meantime.
                    if (sending && sending.length > 0) return [];
                    return queue;
                },

                getQueueDispatchState: (target) => {
                    const key = getMessageQueueKey(target);
                    const state = get();
                    return {
                        head: (state.queuedMessages[key] ?? [])[0] ?? null,
                        sendingIds: state.sendingIds[key] ?? [],
                    };
                },

                 setFollowUpBehavior: (behavior) => {
                    const normalized = normalizeFollowUpBehavior(behavior);
                    set({ followUpBehavior: normalized });
                    void updateDesktopSettings({ followUpBehavior: normalized });
                },

                getQueueForTarget: (target) => {
                    return get().queuedMessages[getMessageQueueKey(target)] ?? [];
                },
            }),
            {
                name: 'message-queue-store',
                version: 2,
                storage: createDeferredSafeJSONStorage(),
                partialize: (state) => ({
                    queuedMessages: state.queuedMessages,
                    quarantinedLegacyMessages: state.quarantinedLegacyMessages,
                    followUpBehavior: state.followUpBehavior,
                }),
                migrate: migrateMessageQueueState,
            }
        ),
        {
            name: 'message-queue-store',
        }
    )
);
