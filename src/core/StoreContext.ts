import { AtomVersionTracker } from './state/AtomVersionTracker'
import { QueueManager } from './state/QueueManager'
import { HistoryRecorder } from './history/HistoryRecorder'
import { OperationApplier } from './ops/OperationApplier'
import { AdapterSync } from './ops/AdapterSync'
import { QueueConfig } from './types'

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
    queueConfig: QueueConfig
}

/**
 * Create a new store context with optional queue configuration
 */
export function createStoreContext(queueConfigOverride?: Partial<QueueConfig>): StoreContext {
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
        queueConfig
    }
}
