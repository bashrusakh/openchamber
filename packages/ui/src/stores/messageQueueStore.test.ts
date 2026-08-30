import { beforeEach, describe, expect, test } from "bun:test"
import {
  createMessageQueueTarget,
  getMessageQueueKey,
  isQueueMessageDispatchable,
  migrateMessageQueueState,
  normalizeFollowUpBehavior,
  parseMessageQueueKey,
  resolveMainSessionSendDisposition,
  useMessageQueueStore,
} from "./messageQueueStore"

beforeEach(() => {
  useMessageQueueStore.setState({ queuedMessages: {}, quarantinedLegacyMessages: {}, sendingIds: {} })
})

describe("message queue runtime ownership", () => {
  test("isolates colliding session IDs by runtime and directory", () => {
    const a = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const b = createMessageQueueTarget("session-1", "/repo", "runtime-b")!
    useMessageQueueStore.getState().addToQueue(a, { content: "from A" })
    useMessageQueueStore.getState().addToQueue(b, { content: "from B" })

    expect(useMessageQueueStore.getState().getQueueForTarget(a)[0]?.content).toBe("from A")
    expect(useMessageQueueStore.getState().getQueueForTarget(b)[0]?.content).toBe("from B")
  })

  test("round trips a composite queue key", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    expect(parseMessageQueueKey(getMessageQueueKey(target))).toEqual(target)
  })

  test("quarantines legacy session-only queues instead of activating them", () => {
    const migrated = migrateMessageQueueState({
      queuedMessages: {
        "session-1": [{ id: "queued-1", content: "legacy", createdAt: 1 }],
      },
    }, 1)

    expect(migrated.queuedMessages).toEqual({})
    expect(migrated.quarantinedLegacyMessages?.["session-1"]?.[0]?.content).toBe("legacy")
  })

  test("bounds each queue to the newest 20 messages", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    for (let index = 0; index < 25; index += 1) {
      useMessageQueueStore.getState().addToQueue(target, { content: `message-${index}` })
    }

    const queue = useMessageQueueStore.getState().getQueueForTarget(target)
    expect(queue).toHaveLength(20)
    expect(queue[0]?.content).toBe("message-5")
  })
})

describe("main-session send disposition", () => {
  test("normalizes all legacy follow-up values to queue", () => {
    expect(normalizeFollowUpBehavior("steer")).toBe("queue")
    expect(normalizeFollowUpBehavior("immediate")).toBe("queue")
    expect(normalizeFollowUpBehavior(undefined, false)).toBe("queue")
    expect(normalizeFollowUpBehavior(undefined, true)).toBe("queue")
  })

  test("queues busy composer submissions, including dictation and preset/direct submit", () => {
    const busyComposer = {
      intent: "composer" as const,
      hasMainSession: true,
      isBtwActive: false,
      isBusy: true,
      canQueue: true,
    }
    expect(resolveMainSessionSendDisposition(busyComposer)).toBe("queue")
    expect(resolveMainSessionSendDisposition({ ...busyComposer })).toBe("queue")
  })

  test("keeps idle composer submissions on the direct-send path", () => {
    expect(resolveMainSessionSendDisposition({
      intent: "composer",
      hasMainSession: true,
      isBtwActive: false,
      isBusy: false,
      canQueue: true,
    })).toBe("send")
  })

  test("preserves a queued chip when busy starts after it rendered idle", () => {
    const rendered = resolveMainSessionSendDisposition({
      intent: "queued",
      hasMainSession: true,
      isBtwActive: false,
      isBusy: false,
      canQueue: true,
    })
    const clicked = resolveMainSessionSendDisposition({
      intent: "queued",
      hasMainSession: true,
      isBtwActive: false,
      isBusy: true,
      canQueue: true,
    })

    expect(rendered).toBe("send")
    expect(clicked).toBe("preserve-queued")
  })

  test("defers composer input while a queued send is in flight", () => {
    expect(resolveMainSessionSendDisposition({
      intent: "composer",
      hasMainSession: true,
      isBtwActive: false,
      isBusy: false,
      canQueue: true,
      hasQueuedMessageInFlight: true,
    })).toBe("queue")
  })
})

describe("in-flight queued sends", () => {
  test("hides a dispatched message from the sendable queue but keeps it visible", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const store = useMessageQueueStore.getState()
    store.addToQueue(target, { content: "first" })
    store.addToQueue(target, { content: "second" })
    const [first, second] = useMessageQueueStore.getState().getQueueForTarget(target)

    expect(isQueueMessageDispatchable([first, second], [], second.id)).toBe(false)
    expect(useMessageQueueStore.getState().markSending(target, second.id)).toBe(false)

    expect(useMessageQueueStore.getState().markSending(target, first.id)).toBe(true)
    expect(useMessageQueueStore.getState().markSending(target, first.id)).toBe(false)

    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toHaveLength(2)
    const sendable = useMessageQueueStore.getState().getSendableQueue(target)
    expect(sendable).toHaveLength(0)

    expect(useMessageQueueStore.getState().getQueueDispatchState(target)).toEqual({
      head: first,
      sendingIds: [first.id],
    })

    useMessageQueueStore.getState().clearSending(target, first.id)
    expect(useMessageQueueStore.getState().getSendableQueue(target)).toHaveLength(2)
    expect(useMessageQueueStore.getState().sendingIds).toEqual({})
  })

  test("clearQueue retains a message whose send is still awaiting the server", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const store = useMessageQueueStore.getState()
    store.addToQueue(target, { content: "in flight" })
    store.addToQueue(target, { content: "merged by composer" })
    const [inFlight] = useMessageQueueStore.getState().getQueueForTarget(target)
    expect(useMessageQueueStore.getState().markSending(target, inFlight.id)).toBe(true)

    useMessageQueueStore.getState().clearQueue(target)

    const remaining = useMessageQueueStore.getState().getQueueForTarget(target)
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.id).toBe(inFlight.id)
  })

  test("clearQueue drops everything once no send is in flight", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    useMessageQueueStore.getState().addToQueue(target, { content: "queued" })

    useMessageQueueStore.getState().clearQueue(target)

    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toHaveLength(0)
  })

  test("clearAllQueues drops non-in-flight entries without releasing a send barrier", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const store = useMessageQueueStore.getState()
    store.addToQueue(target, { content: "in flight" })
    store.addToQueue(target, { content: "later" })
    const [inFlight, later] = useMessageQueueStore.getState().getQueueForTarget(target)
    if (!inFlight || !later) throw new Error("queue items were not created")

    expect(store.markSending(target, inFlight.id)).toBe(true)
    store.clearAllQueues()

    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toEqual([inFlight])
    expect(useMessageQueueStore.getState().getQueueDispatchState(target).sendingIds).toEqual([inFlight.id])
    expect(useMessageQueueStore.getState().getSendableQueue(target)).toEqual([])
    expect(store.markSending(target, later.id)).toBe(false)

    store.completeSending(target, inFlight.id)
    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toEqual([])
    expect(useMessageQueueStore.getState().getQueueDispatchState(target).sendingIds).toEqual([])
  })

  test("clearAllQueues leaves no queue or claims when nothing is in flight", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    useMessageQueueStore.getState().addToQueue(target, { content: "queued" })

    useMessageQueueStore.getState().clearAllQueues()

    expect(useMessageQueueStore.getState().queuedMessages).toEqual({})
    expect(useMessageQueueStore.getState().sendingIds).toEqual({})
  })

  test("keeps the in-flight head when queue capacity trims older items", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    for (let index = 0; index < 20; index += 1) {
      useMessageQueueStore.getState().addToQueue(target, { content: `message-${index}` })
    }

    const first = useMessageQueueStore.getState().getQueueForTarget(target)[0]
    if (!first) throw new Error("queue head was not created")
    expect(useMessageQueueStore.getState().markSending(target, first.id)).toBe(true)

    useMessageQueueStore.getState().addToQueue(target, { content: "newest message" })

    const queue = useMessageQueueStore.getState().getQueueForTarget(target)
    expect(queue).toHaveLength(20)
    expect(queue[0]?.id).toBe(first.id)
    expect(queue[0]?.content).toBe("message-0")
    expect(queue.at(-1)?.content).toBe("newest message")
  })

  test("does not reorder a target while a queued send is in flight", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    useMessageQueueStore.getState().addToQueue(target, { content: "head" })
    useMessageQueueStore.getState().addToQueue(target, { content: "tail" })
    const queue = useMessageQueueStore.getState().getQueueForTarget(target)
    const head = queue[0]
    const tail = queue[1]
    if (!head || !tail) throw new Error("queue items were not created")

    expect(useMessageQueueStore.getState().markSending(target, head.id)).toBe(true)
    useMessageQueueStore.getState().reorderQueue(target, tail.id, head.id)

    expect(useMessageQueueStore.getState().getQueueForTarget(target).map((item) => item.content)).toEqual([
      "head",
      "tail",
    ])
  })

  test("does not remove or pop the in-flight item, but preserves non-in-flight queue edits", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const store = useMessageQueueStore.getState()
    store.addToQueue(target, { content: "head" })
    store.addToQueue(target, { content: "tail" })
    const [head, tail] = useMessageQueueStore.getState().getQueueForTarget(target)
    if (!head || !tail) throw new Error("queue items were not created")

    expect(useMessageQueueStore.getState().markSending(target, head.id)).toBe(true)
    store.removeFromQueue(target, head.id)
    expect(store.popToInput(target, head.id)).toBeNull()
    expect(useMessageQueueStore.getState().getQueueForTarget(target).map((item) => item.id)).toEqual([head.id, tail.id])

    store.removeFromQueue(target, tail.id)
    expect(useMessageQueueStore.getState().getQueueForTarget(target).map((item) => item.id)).toEqual([head.id])
  })

  test("allows remove and pop for non-in-flight items", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const store = useMessageQueueStore.getState()
    store.addToQueue(target, { content: "remove me" })
    store.addToQueue(target, { content: "edit me" })
    const [remove, pop] = useMessageQueueStore.getState().getQueueForTarget(target)
    if (!remove || !pop) throw new Error("queue items were not created")

    store.removeFromQueue(target, remove.id)
    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toEqual([pop])
    expect(store.popToInput(target, pop.id)).toEqual(pop)
    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toEqual([])
  })

  test("completes an in-flight send by removing its item and claim atomically", () => {
    const target = createMessageQueueTarget("session-1", "/repo", "runtime-a")!
    const store = useMessageQueueStore.getState()
    store.addToQueue(target, { content: "head" })
    store.addToQueue(target, { content: "tail" })
    const [head, tail] = useMessageQueueStore.getState().getQueueForTarget(target)
    if (!head || !tail) throw new Error("queue items were not created")

    expect(store.markSending(target, head.id)).toBe(true)
    store.completeSending(target, head.id)

    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toEqual([tail])
    expect(useMessageQueueStore.getState().getQueueDispatchState(target).sendingIds).toEqual([])
    expect(useMessageQueueStore.getState().getSendableQueue(target)).toEqual([tail])
  })
})
