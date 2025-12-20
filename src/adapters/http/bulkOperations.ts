import pLimit from 'p-limit'
import { StoreKey } from '../../core/types'
import type { ObservabilityContext } from '../../observability/types'

export interface BulkOperationConfig {
    bulkCreate?: string | (() => string)
    bulkUpdate?: string | (() => string)
    bulkDelete?: string | (() => string)
    bulkDeleteQueryParam?: {
        path: string | (() => string)
        param: string
        maxUrlLength?: number
    }
    fallback?: 'parallel' | 'sequential' | 'error'
    concurrency?: number
    batchSize?: number
}

export type SinglePutHandler<T> = (item: T, internalContext?: ObservabilityContext) => Promise<void>
export type SingleDeleteHandler = (key: StoreKey, internalContext?: ObservabilityContext) => Promise<void>

export class BulkOperationHandler<T> {
    constructor(
        private config: BulkOperationConfig,
        private handlers: {
            put: SinglePutHandler<T>
            delete: SingleDeleteHandler
        }
    ) { }

    async runFallbackPut(items: T[], internalContext?: ObservabilityContext): Promise<void> {
        if (this.config.fallback === 'error') {
            throw new Error('Bulk update not supported and fallback is disabled')
        }

        const batchSize = this.config.batchSize ?? Infinity
        await this.runInBatches(items, batchSize, async (batch) => {
            const concurrency = this.config.concurrency ?? 5
            if (this.config.fallback === 'parallel') {
                const limit = pLimit(concurrency)
                await Promise.all(batch.map(item => limit(() => this.handlers.put(item, internalContext))))
            } else {
                for (const item of batch) {
                    await this.handlers.put(item, internalContext)
                }
            }
        })
    }

    async runFallbackDelete(keys: StoreKey[], internalContext?: ObservabilityContext): Promise<void> {
        if (this.config.fallback === 'error') {
            throw new Error('Bulk delete not supported and fallback is disabled')
        }

        const batchSize = this.config.batchSize ?? Infinity
        await this.runInBatches(keys, batchSize, async (batch) => {
            const concurrency = this.config.concurrency ?? 5
            if (this.config.fallback === 'parallel') {
                const limit = pLimit(concurrency)
                await Promise.all(batch.map(key => limit(() => this.handlers.delete(key, internalContext))))
            } else {
                for (const key of batch) {
                    await this.handlers.delete(key, internalContext)
                }
            }
        })
    }

    private async runInBatches<I>(items: I[], batchSize: number, fn: (batch: I[]) => Promise<void>) {
        if (!Number.isFinite(batchSize) || batchSize <= 0) {
            batchSize = Infinity
        }

        if (batchSize === Infinity) {
            await fn(items)
            return
        }

        for (let i = 0; i < items.length; i += batchSize) {
            const batch = items.slice(i, i + batchSize)
            await fn(batch)
        }
    }
}
