import type { FindManyOptions, StoreKey } from '../core/types'
import type { ObservabilityContext } from '#observability'
import type { OpsRequest } from './internal'
import { sendBatchRequest } from './internal'
import { QueryLane } from './queryLane'
import type { QueryEnvelope } from './types'
import { WriteLane } from './writeLane'
import type { AtomaPatch } from '#protocol'

type FetchFn = typeof fetch

export interface BatchEngineConfig {
    /** Ops endpoint path (default: `/ops`, aligned with atoma/server default opsPath) */
    endpoint?: string
    /** Custom headers (can be async, e.g. for tokens) */
    headers?: () => Promise<Record<string, string>> | Record<string, string>
    /** Custom fetch implementation (polyfills, timeouts, instrumentation) */
    fetchFn?: FetchFn
    /**
     * Per-lane queue backpressure limit.
     * - number: applies to both query and write lanes
     * - object: configure query/write separately
     * Default: unlimited.
     */
    maxQueueLength?: number | { query?: number; write?: number }
    /**
     * Query-lane overflow strategy when `maxQueueLength` is exceeded:
     * - `reject_new` (default): reject new enqueues
     * - `drop_old_queries`: drop the oldest queued queries (rejecting their promises) and accept new ones
     */
    queryOverflowStrategy?: 'reject_new' | 'drop_old_queries'
    /**
     * Max items per bulk op. For the query lane, this is the max query ops per request.
     * Default: unlimited.
     */
    maxBatchSize?: number
    /** Additional delay before flushing (ms). Default: 0 (coalesce within the same tick). */
    flushIntervalMs?: number
    /** Query-lane max concurrent in-flight requests. Default: 2. */
    queryMaxInFlight?: number
    /** Write-lane max concurrent in-flight requests. Default: 1. */
    writeMaxInFlight?: number
    /**
     * Max ops per HTTP request (shared by query/write lanes).
     * Default: unlimited (still bounded by `maxBatchSize` for writes).
     */
    maxOpsPerRequest?: number
    /** Called when a batch request fails (instrumentation/logging hook). */
    onError?: (error: Error, context: any) => void
}

export class BatchEngine {
    /**
     * In-memory batch scheduler.
     *
     * BatchEngine owns two independent lanes that share a single transport endpoint:
     * - Query lane: coalesces read/query operations into fewer HTTP requests.
     * - Write lane: coalesces mutations into bucketed bulk operations with fairness.
     *
     * This class intentionally owns:
     * - scheduling (microtasks/timers)
     * - lifecycle (`dispose`)
     * - shared transport (`send`)
     *
     * Lane state + drain algorithms live inside `QueryLane` / `WriteLane`.
     */
    private seq = 0

    private readonly endpoint: string
    private readonly fetcher: FetchFn

    private readonly queryLane: QueryLane
    private readonly writeLane: WriteLane

    constructor(private readonly config: BatchEngineConfig = {}) {
        this.endpoint = (config.endpoint || '/ops').replace(/\/$/, '')
        this.fetcher = config.fetchFn ?? fetch

        this.queryLane = new QueryLane({
            endpoint: () => this.endpoint,
            config: () => this.config,
            send: (payload, signal, extraHeaders) => this.send(payload, signal, extraHeaders),
            nextOpId: prefix => this.nextOpId(prefix)
        })

        this.writeLane = new WriteLane({
            endpoint: () => this.endpoint,
            config: () => this.config,
            send: (payload, signal, extraHeaders) => this.send(payload, signal, extraHeaders),
            nextOpId: prefix => this.nextOpId(prefix)
        })
    }

    enqueueQuery<T>(
        resource: string,
        params: FindManyOptions<T> | undefined,
        fallback: () => Promise<any>,
        internalContext?: ObservabilityContext
    ): Promise<QueryEnvelope<T>> {
        return this.queryLane.enqueue(resource, params, fallback, internalContext)
    }

    enqueueCreate<T>(resource: string, item: T, internalContext?: ObservabilityContext): Promise<any> {
        return this.writeLane.enqueueCreate(resource, item, internalContext)
    }

    enqueueUpdate<T>(
        resource: string,
        item: { id: StoreKey; data: T; baseVersion: number; meta?: { idempotencyKey?: string } },
        internalContext?: ObservabilityContext
    ): Promise<void> {
        return this.writeLane.enqueueUpdate(resource, item, internalContext)
    }

    enqueuePatch(
        resource: string,
        item: { id: StoreKey; patches: AtomaPatch[]; baseVersion: number; timestamp?: number; meta?: { idempotencyKey?: string } },
        internalContext?: ObservabilityContext
    ): Promise<void> {
        return this.writeLane.enqueuePatch(resource, item, internalContext)
    }

    enqueueDelete(
        resource: string,
        item: { id: StoreKey; baseVersion: number; meta?: { idempotencyKey?: string } },
        internalContext?: ObservabilityContext
    ): Promise<void> {
        return this.writeLane.enqueueDelete(resource, item, internalContext)
    }

    dispose() {
        this.queryLane.dispose()
        this.writeLane.dispose()
    }

    private async send(payload: OpsRequest, signal?: AbortSignal, extraHeaders?: Record<string, string>) {
        return await sendBatchRequest(this.fetcher, this.endpoint, this.config.headers, payload, signal, extraHeaders)
    }

    private nextOpId(prefix: 'q' | 'w') {
        return `${prefix}_${Date.now()}_${this.seq++}`
    }
}
