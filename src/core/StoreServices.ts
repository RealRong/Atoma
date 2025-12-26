import type { QueueConfig } from './types'
import type { IStore, StoreToken } from './types'
import type { DebugConfig, DebugEvent } from '#observability'
import { MutationPipeline } from './mutation'

/**
 * Per-store services holding dependencies
 * Replaces global singletons for better SSR/test/multi-instance support
 */
export interface StoreServices {
    mutation: MutationPipeline
    resolveStore?: (name: StoreToken) => IStore<any> | undefined
    debug?: DebugConfig
    debugSink?: (e: DebugEvent) => void
}

export function createStoreServices(
    _queueConfigOverride?: Partial<QueueConfig>,
    options?: {
        debug?: DebugConfig
        debugSink?: (e: DebugEvent) => void
        resolveStore?: (name: StoreToken) => IStore<any> | undefined
    }
): StoreServices {
    const services: StoreServices = {
        mutation: new MutationPipeline(),
        resolveStore: options?.resolveStore,
        debug: options?.debug,
        debugSink: options?.debugSink
    }

    return services
}
