import pLimit from 'p-limit'
import { StoreKey } from '../../core/types'
import { OfflineQueue, QueuedOperation } from './offlineQueue'
import { HTTPEventEmitter } from './eventEmitter'

export interface QueueSyncConfig {
    concurrency?: number
    maxRetries: number
}

export type OperationExecutor = (op: QueuedOperation) => Promise<void>

export class QueueSynchronizer {
    private syncInProgress: boolean = false

    constructor(
        private queue: OfflineQueue,
        private events: HTTPEventEmitter,
        private executor: OperationExecutor,
        private config: QueueSyncConfig
    ) { }

    async sync(): Promise<void> {
        if (this.syncInProgress || this.queue.size() === 0) return

        this.syncInProgress = true
        this.events.emitSyncStart(this.queue.size())

        try {
            console.log(`Syncing ${this.queue.size()} queued operations...`)

            const snapshot = this.queue.snapshot()

            // Group operations by key to maintain ordering per key
            const opsByKey = new Map<StoreKey, QueuedOperation[]>()
            for (const op of snapshot) {
                if (!op.key) continue
                if (!opsByKey.has(op.key)) {
                    opsByKey.set(op.key, [])
                }
                opsByKey.get(op.key)!.push(op)
            }

            // Process each key's operations in parallel (up to concurrency limit)
            const limit = pLimit(this.config.concurrency ?? 5)
            const stillPending: QueuedOperation[] = []

            await Promise.all(
                Array.from(opsByKey.entries()).map(([key, ops]) =>
                    limit(async () => {
                        // Process operations for this key sequentially to maintain ordering
                        for (const op of ops) {
                            try {
                                await this.executor(op)
                            } catch (error) {
                                const retryCount = (op.retryCount || 0) + 1
                                if (retryCount < this.config.maxRetries) {
                                    stillPending.push({ ...op, retryCount })
                                } else {
                                    this.events.emitSyncError(error as Error, op)
                                    console.error('Dropping queued operation after max retries:', {
                                        opType: op.type,
                                        key: op.key,
                                        error
                                    })
                                }
                            }
                        }
                    })
                )
            )

            this.queue.clear()
            stillPending.forEach(op => this.queue.enqueue(op))

            console.log(`Sync complete. ${this.queue.size()} operations remaining in queue.`)
        } finally {
            this.syncInProgress = false
            this.events.emitSyncComplete(this.queue.size())
        }
    }
}
