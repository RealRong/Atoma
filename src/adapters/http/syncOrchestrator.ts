import { HTTPEventEmitter } from './eventEmitter'
import { OfflineQueue, QueuedOperation } from './offlineQueue'
import { QueueSynchronizer } from './queueSync'
import { NetworkStateManager } from './networkState'
import type { HTTPClient } from './client'
import type { HTTPAdapterConfig, RetryConfig } from '../HTTPAdapter'
import type { DevtoolsBridge } from '../../devtools/types'
import { registerGlobalQueue } from '../../devtools/global'
import type { StoreKey, Entity } from '../../core/types'

type OpKind = 'put' | 'delete'

/**
 * Encapsulates network state + offline queue + sync logic so HTTPAdapter stays thin.
 */
export class SyncOrchestrator<T extends Entity> {
    private networkState: NetworkStateManager
    private offlineQueue: OfflineQueue
    private queueSync: QueueSynchronizer
    private maxRetries: number

    constructor(
        private config: HTTPAdapterConfig<T>,
        private deps: {
            queueStorageKey: string
            eventEmitter: HTTPEventEmitter
            client: HTTPClient<T>
            retry?: RetryConfig
            devtools?: DevtoolsBridge
        }
    ) {
        this.maxRetries = deps.retry?.maxAttempts ?? 3

        this.networkState = new NetworkStateManager(
            () => {
                if (this.config.offline?.syncOnReconnect !== false) {
                    this.syncQueue()
                }
            },
            () => { }
        )

        this.offlineQueue = new OfflineQueue(
            deps.queueStorageKey,
            {
                onQueueChange: config.events?.onQueueChange,
                onQueueFull: (dropped) => config.events?.onQueueFull?.(dropped, config.offline?.maxQueueSize || 1000)
            },
            config.offline?.maxQueueSize
        )
        const queueSnapshot = () => ({
            pending: this.offlineQueue.snapshot().map(op => ({ ...op, retries: op.retryCount ?? 0 })),
            failed: []
        })
        deps.devtools?.registerQueue?.({
            name: config.resourceName || deps.queueStorageKey,
            snapshot: queueSnapshot
        }) || registerGlobalQueue({
            name: config.resourceName || deps.queueStorageKey,
            snapshot: queueSnapshot
        })

        this.queueSync = new QueueSynchronizer(
            this.offlineQueue,
            deps.eventEmitter,
            async (op) => {
                if (!op.key) return
                if (op.type === 'put' && op.value) {
                    await deps.client.put(op.key, op.value)
                } else if (op.type === 'delete') {
                    await deps.client.delete(op.key)
                }
            },
            {
                concurrency: this.config.concurrency?.bulk,
                maxRetries: this.maxRetries
            }
        )
    }

    dispose() {
        this.networkState.dispose()
    }

    isNetworkError(error: any): boolean {
        return this.networkState.isNetworkError(error)
    }

    get isOnline() {
        return this.networkState.isOnline
    }

    /**
     * Execute an operation; on offline or network error, enqueue when enabled.
     */
    async handleWithOfflineFallback(
        op: { type: OpKind; key: StoreKey; value?: any },
        action: () => Promise<void>
    ): Promise<void> {
        if (!this.networkState.isOnline && this.config.offline?.enabled) {
            await this.queueOperation(op)
            return
        }

        try {
            await action()
        } catch (error) {
            if (this.isNetworkError(error) && this.config.offline?.enabled) {
                await this.queueOperation(op)
                return
            }
            throw error
        }
    }

    async syncQueue(): Promise<void> {
        await this.queueSync.sync()
    }

    private async queueOperation(op: { type: OpKind; key: StoreKey; value?: any }) {
        const queued: QueuedOperation = {
            id: this.generateOperationId(),
            type: op.type,
            key: op.key,
            value: op.value,
            timestamp: Date.now()
        }
        await this.offlineQueue.enqueue(queued)
    }

    private generateOperationId(): string {
        if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
            return (crypto as any).randomUUID()
        }
        return `${Date.now()}-${Math.random().toString(16).slice(2)}`
    }
}
