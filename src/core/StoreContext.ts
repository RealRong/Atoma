import { AtomVersionTracker } from './state/AtomVersionTracker'
import { QueueManager } from './state/QueueManager'
import { HistoryRecorder } from './history/HistoryRecorder'
import { OperationApplier } from './ops/OperationApplier'
import { AdapterSync } from './ops/AdapterSync'
import { QueueConfig } from './types'
import { IndexRegistry, globalIndexRegistry } from './indexes/IndexRegistry'
import type { DebugOptions } from '../observability/types'
import type { DebugEvent } from '../observability/types'

/**
 * Per-store context holding dependencies
 * Replaces global singletons for better SSR/test/multi-instance support
 */
export interface StoreContext {
    versionTracker: AtomVersionTracker
    queueManager: QueueManager
    historyRecorder: HistoryRecorder
    operationApplier: OperationApplier
    adapterSync: AdapterSync
    indexRegistry: IndexRegistry
    queueConfig: QueueConfig
    debug?: DebugOptions
    debugSink?: (e: DebugEvent) => void
    storeName?: string
}

export function createStoreContext(
    queueConfigOverride?: Partial<QueueConfig>,
    options?: { debug?: DebugOptions; debugSink?: (e: DebugEvent) => void; storeName?: string }
): StoreContext {
    const queueConfig: QueueConfig = {
        enabled: true,
        debug: false,
        ...queueConfigOverride
    }

    return {
        versionTracker: new AtomVersionTracker(),
        queueManager: new QueueManager(),
        historyRecorder: new HistoryRecorder(),
        operationApplier: new OperationApplier(),
        adapterSync: new AdapterSync(),
        indexRegistry: globalIndexRegistry,
        queueConfig,
        debug: options?.debug,
        debugSink: options?.debugSink,
        storeName: options?.storeName
    }
}
