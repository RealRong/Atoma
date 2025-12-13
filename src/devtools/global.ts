import { createDevtoolsBridge } from './bridge'
import type { DevtoolsBridge, StoreSnapshot, IndexSnapshotPayload, QueueItem, HistoryEntrySummary } from './types'

let globalBridge: DevtoolsBridge | undefined

type PendingStore = { name: string; snapshot: () => StoreSnapshot }
type PendingIndex = { name: string; snapshot: () => IndexSnapshotPayload }
type PendingQueue = { name: string; snapshot: () => { pending: QueueItem[]; failed?: QueueItem[] } }
type PendingHistory = { name: string; snapshot: () => { pointer: number; length: number; entries: HistoryEntrySummary[] } }

const pending = {
    stores: [] as PendingStore[],
    indexes: [] as PendingIndex[],
    queues: [] as PendingQueue[],
    histories: [] as PendingHistory[]
}

function flushPending(): void {
    if (!globalBridge) return
    pending.stores.forEach(p => globalBridge?.registerStore?.(p))
    pending.indexes.forEach(p => globalBridge?.registerIndexManager?.(p))
    pending.queues.forEach(p => globalBridge?.registerQueue?.(p))
    pending.histories.forEach(p => globalBridge?.registerHistory?.(p))
    pending.stores.length = 0
    pending.indexes.length = 0
    pending.queues.length = 0
    pending.histories.length = 0
}

export function enableGlobalDevtools(options?: { snapshotIntervalMs?: number }): DevtoolsBridge {
    globalBridge = createDevtoolsBridge(options)
    flushPending()
    return globalBridge
}

export function getGlobalDevtools(): DevtoolsBridge | undefined {
    return globalBridge
}

export function disableGlobalDevtools(): void {
    globalBridge = undefined
}

// 注册助手：若全局未启用则挂起，启用后自动 flush
export function registerGlobalStore(p: PendingStore): () => void {
    if (globalBridge) return globalBridge.registerStore?.(p) || (() => { })
    pending.stores.push(p)
    return () => { }
}

export function registerGlobalIndex(p: PendingIndex): () => void {
    if (globalBridge) return globalBridge.registerIndexManager?.(p) || (() => { })
    pending.indexes.push(p)
    return () => { }
}

export function registerGlobalQueue(p: PendingQueue): () => void {
    if (globalBridge) return globalBridge.registerQueue?.(p) || (() => { })
    pending.queues.push(p)
    return () => { }
}

export function registerGlobalHistory(p: PendingHistory): () => void {
    if (globalBridge) return globalBridge.registerHistory?.(p) || (() => { })
    pending.histories.push(p)
    return () => { }
}
