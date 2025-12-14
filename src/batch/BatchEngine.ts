import type { FindManyOptions, StoreKey } from '../core/types'
import { createRequestIdSequencer } from '../observability/trace'
import type { RequestIdSequencer } from '../observability/trace'
import type { InternalOperationContext } from '../observability/types'
import { isWriteQueueFull, normalizeMaxBatchSize, normalizeMaxQueueLength, normalizeMaxQueryOpsPerRequest } from './config'
import { drainQueryLane } from './queryLane'
import { sendBatchRequest } from './transport'
import type { Deferred, QueryEnvelope, QueryTask, WriteTask } from './types'
import { bucketKey, drainWriteLane } from './writeLane'

type FetchFn = typeof fetch

export interface BatchEngineConfig {
    /** 批量端点，默认 /batch（与 atoma/server 默认 batchPath 对齐） */
    endpoint?: string
    /** 自定义 headers（可异步获取 token） */
    headers?: () => Promise<Record<string, string>> | Record<string, string>
    /** 自定义 fetch（便于 polyfill 或注入超时） */
    fetchFn?: FetchFn
    /**
     * 队列背压上限（per-lane）。
     * - number：同时应用到 query/write
     * - object：分别指定 query/write
     * 默认无限制。
     */
    maxQueueLength?: number | { query?: number; write?: number }
    /**
     * query lane 超过 maxQueueLength 时的策略：
     * - reject_new（默认）：拒绝新入队
     * - drop_old_queries：丢弃最旧的 query（reject 被丢弃的 promise），再接受新入队
     */
    queryOverflowStrategy?: 'reject_new' | 'drop_old_queries'
    /**
     * 单个 bulk op 的最大 item 数；query lane 则表示单次请求最多带多少个 query op。
     * 默认无限制。
     */
    maxBatchSize?: number
    /** 额外延迟 flush 的毫秒数；默认 0（同一事件循环聚合） */
    flushIntervalMs?: number
    /** query lane 最大并发请求数；默认 2 */
    queryMaxInFlight?: number
    /** write lane 最大并发请求数；默认 1 */
    writeMaxInFlight?: number
    /**
     * 单次 HTTP 请求最多携带多少个 op（query/write 共用）。
     * 默认无限制（仅受 maxBatchSize 影响）。
     */
    maxOpsPerRequest?: number
    /** 统一的 requestId 生成器（用于跨 query/write 共享序列） */
    requestIdSequencer?: RequestIdSequencer
    /** 批量请求失败时的回调，用于埋点或日志 */
    onError?: (error: Error, context: any) => void
}

export class BatchEngine {
    private disposed = false
    private seq = 0
    private readonly disposedError = new Error('BatchEngine disposed')
    private readonly queueOverflowError = new Error('BatchEngine queue overflow')
    private readonly droppedQueryError = new Error('BatchEngine dropped old query due to queue overflow')

    private readonly endpoint: string
    private readonly fetcher: FetchFn
    private readonly inFlightControllers = new Set<AbortController>()
    private readonly inFlightTasks = new Set<{ deferred: Deferred<any> }>()

    // query lane
    private queryQueue: Array<QueryTask<any>> = []
    private queryScheduled = false
    private queryTimer?: ReturnType<typeof setTimeout>
    private queryInFlight = 0

    // write lane (bucketed)
    private writeBuckets = new Map<string, WriteTask[]>()
    private writeReady: string[] = []
    private writeReadySet = new Set<string>()
    private writeScheduled = false
    private writeTimer?: ReturnType<typeof setTimeout>
    private writeInFlight = 0
    private writePendingCount = 0
    private readonly requestIdSequencer: RequestIdSequencer

    constructor(private readonly config: BatchEngineConfig = {}) {
        this.endpoint = (config.endpoint || '/batch').replace(/\/$/, '')
        this.fetcher = config.fetchFn ?? fetch
        this.requestIdSequencer = config.requestIdSequencer ?? createRequestIdSequencer()
    }

    enqueueQuery<T>(resource: string, params: FindManyOptions<T> | undefined, fallback: () => Promise<any>): Promise<QueryEnvelope<T>> {
        const internalContext = (arguments as any)[3] as InternalOperationContext | undefined
        return new Promise((resolve, reject) => {
            if (this.disposed) {
                reject(this.disposedError)
                return
            }

            const maxLen = normalizeMaxQueueLength(this.config, 'query')
            if (maxLen !== Infinity) {
                const strategy = this.config.queryOverflowStrategy ?? 'reject_new'
                if (strategy === 'drop_old_queries') {
                    while (this.queryQueue.length >= maxLen) {
                        const dropped = this.queryQueue.shift()
                        dropped?.deferred.reject(this.droppedQueryError)
                    }
                } else {
                    if (this.queryQueue.length >= maxLen) {
                        reject(this.queueOverflowError)
                        return
                    }
                }
            }

            const opId = this.nextOpId('q')
            this.queryQueue.push({
                kind: 'query',
                opId,
                resource,
                params,
                traceId: typeof internalContext?.traceId === 'string' && internalContext.traceId ? internalContext.traceId : undefined,
                debugEmitter: internalContext?.emitter,
                fallback,
                deferred: { resolve, reject }
            })

            this.signalQueryLane()
        })
    }

    enqueueCreate<T>(resource: string, item: T): Promise<any> {
        const internalContext = (arguments as any)[2] as InternalOperationContext | undefined
        return new Promise((resolve, reject) => {
            if (this.disposed) {
                reject(this.disposedError)
                return
            }
            if (isWriteQueueFull(this.config, this.writePendingCount)) {
                reject(this.queueOverflowError)
                return
            }
            this.pushWriteTask({ kind: 'create', resource, item, deferred: { resolve, reject }, traceId: internalContext?.traceId, debugEmitter: internalContext?.emitter })
        })
    }

    enqueueUpdate<T>(
        resource: string,
        item: { id: StoreKey; data: T; clientVersion?: any },
    ): Promise<void> {
        const internalContext = (arguments as any)[2] as InternalOperationContext | undefined
        return new Promise((resolve, reject) => {
            if (this.disposed) {
                reject(this.disposedError)
                return
            }
            if (isWriteQueueFull(this.config, this.writePendingCount)) {
                reject(this.queueOverflowError)
                return
            }
            this.pushWriteTask({ kind: 'update', resource, item, deferred: { resolve, reject }, traceId: internalContext?.traceId, debugEmitter: internalContext?.emitter })
        })
    }

    enqueuePatch(
        resource: string,
        item: { id: StoreKey; patches: any[]; baseVersion?: number; timestamp?: number },
    ): Promise<void> {
        const internalContext = (arguments as any)[2] as InternalOperationContext | undefined
        return new Promise((resolve, reject) => {
            if (this.disposed) {
                reject(this.disposedError)
                return
            }
            if (isWriteQueueFull(this.config, this.writePendingCount)) {
                reject(this.queueOverflowError)
                return
            }
            this.pushWriteTask({ kind: 'patch', resource, item, deferred: { resolve, reject }, traceId: internalContext?.traceId, debugEmitter: internalContext?.emitter })
        })
    }

    enqueueDelete(resource: string, id: StoreKey): Promise<void> {
        const internalContext = (arguments as any)[2] as InternalOperationContext | undefined
        return new Promise((resolve, reject) => {
            if (this.disposed) {
                reject(this.disposedError)
                return
            }
            if (isWriteQueueFull(this.config, this.writePendingCount)) {
                reject(this.queueOverflowError)
                return
            }
            this.pushWriteTask({ kind: 'delete', resource, id, deferred: { resolve, reject }, traceId: internalContext?.traceId, debugEmitter: internalContext?.emitter })
        })
    }

    dispose() {
        this.disposed = true

        this.queryScheduled = false
        if (this.queryTimer) {
            clearTimeout(this.queryTimer)
            this.queryTimer = undefined
        }

        this.writeScheduled = false
        if (this.writeTimer) {
            clearTimeout(this.writeTimer)
            this.writeTimer = undefined
        }

        // best-effort abort in-flight requests
        for (const controller of this.inFlightControllers.values()) {
            try {
                controller.abort()
            } catch {
                // ignore
            }
        }
        this.inFlightControllers.clear()

        const pendingQueries = this.queryQueue.splice(0, this.queryQueue.length)
        pendingQueries.forEach(t => t.deferred.reject(this.disposedError))

        for (const tasks of this.writeBuckets.values()) {
            tasks.forEach(t => t.deferred.reject(this.disposedError))
        }
        this.writeBuckets.clear()
        this.writeReady = []
        this.writeReadySet.clear()
        this.writePendingCount = 0

        // reject tasks that were already dequeued into an in-flight request
        for (const task of this.inFlightTasks.values()) {
            task.deferred.reject(this.disposedError)
        }
        this.inFlightTasks.clear()
    }

    private pushWriteTask(task: WriteTask) {
        const key = bucketKey(task)
        const list = this.writeBuckets.get(key) ?? []
        list.push(task)
        this.writeBuckets.set(key, list)
        this.writePendingCount++

        if (!this.writeReadySet.has(key)) {
            this.writeReady.push(key)
            this.writeReadySet.add(key)
        }

        this.signalWriteLane()
    }

    private signalQueryLane() {
        if (this.disposed) return

        const max = normalizeMaxQueryOpsPerRequest(this.config)
        if (max !== Infinity && this.queryQueue.length >= max) {
            this.scheduleQueryRun(true)
            return
        }
        this.scheduleQueryRun(false)
    }

    private signalWriteLane() {
        if (this.disposed) return

        const max = normalizeMaxBatchSize(this.config)
        // 若任意 bucket 达到 maxBatchSize，立即尝试 flush
        if (max !== Infinity) {
            for (const tasks of this.writeBuckets.values()) {
                if (tasks.length >= max) {
                    this.scheduleWriteRun(true)
                    return
                }
            }
        }
        this.scheduleWriteRun(false)
    }

    private scheduleQueryRun(immediate: boolean) {
        if (this.queryScheduled) {
            // 若已被 timer 安排（flushIntervalMs>0），当达到阈值时需要“升级”为立即 flush
            if (immediate && this.queryTimer) {
                clearTimeout(this.queryTimer)
                this.queryTimer = undefined
                queueMicrotask(() => this.runQueryLane())
            }
            return
        }
        this.queryScheduled = true

        const delay = this.config.flushIntervalMs ?? 0
        if (!immediate && delay > 0) {
            this.queryTimer = setTimeout(() => this.runQueryLane(), delay)
            return
        }
        queueMicrotask(() => this.runQueryLane())
    }

    private scheduleWriteRun(immediate: boolean) {
        if (this.writeScheduled) {
            // 若已被 timer 安排（flushIntervalMs>0），当达到阈值时需要“升级”为立即 flush
            if (immediate && this.writeTimer) {
                clearTimeout(this.writeTimer)
                this.writeTimer = undefined
                queueMicrotask(() => this.runWriteLane())
            }
            return
        }
        this.writeScheduled = true

        const delay = this.config.flushIntervalMs ?? 0
        if (!immediate && delay > 0) {
            this.writeTimer = setTimeout(() => this.runWriteLane(), delay)
            return
        }
        queueMicrotask(() => this.runWriteLane())
    }

    private runQueryLane() {
        this.queryScheduled = false
        if (this.queryTimer) {
            clearTimeout(this.queryTimer)
            this.queryTimer = undefined
        }
        if (this.disposed) return
        void drainQueryLane(this as any)
    }

    private runWriteLane() {
        this.writeScheduled = false
        if (this.writeTimer) {
            clearTimeout(this.writeTimer)
            this.writeTimer = undefined
        }
        if (this.disposed) return
        void drainWriteLane(this as any)
    }

    private async send(payload: any, signal?: AbortSignal, extraHeaders?: Record<string, string>) {
        return await sendBatchRequest(this.fetcher, this.endpoint, this.config.headers, payload, signal, extraHeaders)
    }

    private nextOpId(prefix: 'q' | 'w') {
        return `${prefix}_${Date.now()}_${this.seq++}`
    }

    private nextRequestId(traceId: string) {
        return this.requestIdSequencer.next(traceId)
    }
}
