import { AtomVersionTracker } from './state/AtomVersionTracker'
import { QueueManager } from './state/QueueManager'
import { OperationApplier } from './ops/OperationApplier'
import { AdapterSync } from './ops/AdapterSync'
import { QueueConfig } from './types'
import type { DebugConfig, DebugEvent } from '#observability'
import type { OperationRecorder } from './ops/OperationRecorder'
import { NoopOperationRecorder } from './ops/OperationRecorder'

/**
 * Per-store context holding dependencies
 * Replaces global singletons for better SSR/test/multi-instance support
 */
export interface StoreContext {
    versionTracker: AtomVersionTracker
    queueManager: QueueManager
    operationRecorder: OperationRecorder
    operationApplier: OperationApplier
    adapterSync: AdapterSync
    queueConfig: QueueConfig
    debug?: DebugConfig
    debugSink?: (e: DebugEvent) => void
    storeName?: string
}

export function createStoreContext(
    queueConfigOverride?: Partial<QueueConfig>,
    options?: { debug?: DebugConfig; debugSink?: (e: DebugEvent) => void; storeName?: string; operationRecorder?: OperationRecorder }
): StoreContext {
    const queueConfig: QueueConfig = {
        enabled: true,
        debug: false,
        ...queueConfigOverride
    }

    return {
        versionTracker: new AtomVersionTracker(),
        queueManager: new QueueManager(),
        operationRecorder: options?.operationRecorder ?? new NoopOperationRecorder(),
        operationApplier: new OperationApplier(),
        adapterSync: new AdapterSync(),
        queueConfig,
        debug: options?.debug,
        debugSink: options?.debugSink,
        storeName: options?.storeName
    }
}
