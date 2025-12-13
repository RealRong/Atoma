import type { FindManyOptions, PageInfo, StoreKey } from '../core/types'

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
    /** 批量请求失败时的回调，用于埋点或日志 */
    onError?: (error: Error, context: any) => void
}

type Deferred<T> = {
    resolve: (value: T) => void
    reject: (reason?: any) => void
}

type QueryTask<T> = {
    kind: 'query'
    opId: string
    resource: string
    params: FindManyOptions<T> | undefined
    fallback: () => Promise<{ data: T[]; pageInfo?: PageInfo } | T[]>
    deferred: Deferred<{ data: T[]; pageInfo?: PageInfo } | T[]>
}

type CreateTask<T> = {
    kind: 'create'
    resource: string
    item: T
    deferred: Deferred<any>
}

type UpdateTask<T> = {
    kind: 'update'
    resource: string
    item: { id: StoreKey; data: T; clientVersion?: any }
    deferred: Deferred<void>
}

type PatchTask = {
    kind: 'patch'
    resource: string
    item: { id: StoreKey; patches: any[]; baseVersion?: number; timestamp?: number }
    deferred: Deferred<void>
}

type DeleteTask = {
    kind: 'delete'
    resource: string
    id: StoreKey
    deferred: Deferred<void>
}

type WriteTask = CreateTask<any> | UpdateTask<any> | PatchTask | DeleteTask

type BatchOpResult = {
    opId: string
    ok: boolean
    data?: any[]
    pageInfo?: PageInfo
    partialFailures?: Array<{ index: number; error: any }>
    error?: any
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

    constructor(private readonly config: BatchEngineConfig = {}) {
        this.endpoint = (config.endpoint || '/batch').replace(/\/$/, '')
        this.fetcher = config.fetchFn ?? fetch
    }

    enqueueQuery<T>(
        resource: string,
        params: FindManyOptions<T> | undefined,
        fallback: () => Promise<{ data: T[]; pageInfo?: PageInfo } | T[]>
    ): Promise<{ data: T[]; pageInfo?: PageInfo } | T[]> {
        return new Promise((resolve, reject) => {
            if (this.disposed) {
                reject(this.disposedError)
                return
            }

            const maxLen = this.normalizeMaxQueueLength('query')
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
                fallback,
                deferred: { resolve, reject }
            })

            this.signalQueryLane()
        })
    }

    enqueueCreate<T>(resource: string, item: T): Promise<any> {
        return new Promise((resolve, reject) => {
            if (this.disposed) {
                reject(this.disposedError)
                return
            }
            if (this.isWriteQueueFull()) {
                reject(this.queueOverflowError)
                return
            }
            this.pushWriteTask({ kind: 'create', resource, item, deferred: { resolve, reject } })
        })
    }

    enqueueUpdate<T>(resource: string, item: { id: StoreKey; data: T; clientVersion?: any }): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.disposed) {
                reject(this.disposedError)
                return
            }
            if (this.isWriteQueueFull()) {
                reject(this.queueOverflowError)
                return
            }
            this.pushWriteTask({ kind: 'update', resource, item, deferred: { resolve, reject } })
        })
    }

    enqueuePatch(
        resource: string,
        item: { id: StoreKey; patches: any[]; baseVersion?: number; timestamp?: number }
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.disposed) {
                reject(this.disposedError)
                return
            }
            if (this.isWriteQueueFull()) {
                reject(this.queueOverflowError)
                return
            }
            this.pushWriteTask({ kind: 'patch', resource, item, deferred: { resolve, reject } })
        })
    }

    enqueueDelete(resource: string, id: StoreKey): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.disposed) {
                reject(this.disposedError)
                return
            }
            if (this.isWriteQueueFull()) {
                reject(this.queueOverflowError)
                return
            }
            this.pushWriteTask({ kind: 'delete', resource, id, deferred: { resolve, reject } })
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

        const max = this.normalizeMaxQueryOpsPerRequest()
        if (max !== Infinity && this.queryQueue.length >= max) {
            this.scheduleQueryRun(true)
            return
        }
        this.scheduleQueryRun(false)
    }

    private signalWriteLane() {
        if (this.disposed) return

        const max = this.normalizeMaxBatchSize()
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
        void this.drainQueryLane()
    }

    private runWriteLane() {
        this.writeScheduled = false
        if (this.writeTimer) {
            clearTimeout(this.writeTimer)
            this.writeTimer = undefined
        }
        if (this.disposed) return
        void this.drainWriteLane()
    }

    private async drainQueryLane() {
        const maxInFlight = clampInt(this.config.queryMaxInFlight ?? 2, 1, 64)
        const maxOps = this.normalizeMaxQueryOpsPerRequest()

        while (!this.disposed && this.queryInFlight < maxInFlight && this.queryQueue.length) {
            const batch = this.queryQueue.splice(0, maxOps === Infinity ? this.queryQueue.length : maxOps)
            this.queryInFlight++
            batch.forEach(t => this.inFlightTasks.add(t as any))
            const controller = createAbortController()
            if (controller) this.inFlightControllers.add(controller)

            try {
                const payload = {
                    ops: batch.map(t => ({
                        opId: t.opId,
                        action: 'query',
                        query: {
                            resource: t.resource,
                            params: normalizeAtomaServerQueryParams(t.params)
                        }
                    }))
                }

                const response = await this.send(payload, controller?.signal)
                const resultMap = mapResults(response?.results)

                for (const task of batch) {
                    if (this.disposed) {
                        task.deferred.reject(this.disposedError)
                        continue
                    }
                    const res = resultMap.get(task.opId)
                    if (!res || res.ok === false || res.error) {
                        await this.runQueryFallback(task, res?.error)
                        continue
                    }
                    const normalized = normalizeQueryEnvelope(res)
                    task.deferred.resolve(normalized)
                }
            } catch (error: any) {
                this.config.onError?.(toError(error), { lane: 'query' })
                for (const task of batch) {
                    if (this.disposed) {
                        task.deferred.reject(this.disposedError)
                        continue
                    }
                    await this.runQueryFallback(task, error)
                }
            } finally {
                if (controller) this.inFlightControllers.delete(controller)
                batch.forEach(t => this.inFlightTasks.delete(t as any))
                this.queryInFlight--
            }
        }

        if (!this.disposed && this.queryQueue.length) {
            this.signalQueryLane()
        }
    }

    private async drainWriteLane() {
        const maxInFlight = clampInt(this.config.writeMaxInFlight ?? 1, 1, 64)
        const maxItems = this.normalizeMaxBatchSize()
        const maxOps = this.normalizeMaxOpsPerRequest()

        while (!this.disposed && this.writeInFlight < maxInFlight && this.writeReady.length) {
            const ops: any[] = []
            const slicesByOpId = new Map<string, WriteTask[]>()

            while (ops.length < maxOps && this.writeReady.length) {
                // round-robin：取队首 bucketKey
                const key = this.writeReady.shift()!
                this.writeReadySet.delete(key)

                const tasks = this.writeBuckets.get(key)
                if (!tasks || !tasks.length) {
                    this.writeBuckets.delete(key)
                    continue
                }

                // 每次从该 bucket 取一段，最多 maxItems
                const slice = tasks.splice(0, maxItems === Infinity ? tasks.length : maxItems)
                this.writePendingCount -= slice.length
                if (!tasks.length) {
                    this.writeBuckets.delete(key)
                } else {
                    // bucket 仍有剩余，放回队尾保持公平
                    this.writeReady.push(key)
                    this.writeReadySet.add(key)
                }

                const opId = this.nextOpId('w')
                ops.push(buildWriteOp(opId, key, slice))
                slicesByOpId.set(opId, slice)
            }

            if (!ops.length) break

            this.writeInFlight++
            for (const slice of slicesByOpId.values()) {
                slice.forEach(t => this.inFlightTasks.add(t as any))
            }
            const controller = createAbortController()
            if (controller) this.inFlightControllers.add(controller)
            try {
                const response = await this.send({ ops }, controller?.signal)
                const resultMap = mapResults(response?.results)

                for (const [opId, slice] of slicesByOpId.entries()) {
                    if (this.disposed) {
                        slice.forEach(t => t.deferred.reject(this.disposedError))
                        continue
                    }
                    const res = resultMap.get(opId)

                    if (!res || res.ok === false || res.error) {
                        const err = res?.error ?? new Error('Batch write failed')
                        this.config.onError?.(toError(err), { lane: 'write', opId })
                        slice.forEach(t => t.deferred.reject(err))
                        continue
                    }

                    const failures = new Set<number>()
                    res.partialFailures?.forEach((f: any) => failures.add(f.index))

                    slice.forEach((task, index) => {
                        if (failures.has(index)) {
                            const failure = res.partialFailures?.find((f: any) => f.index === index)
                            task.deferred.reject(failure?.error ?? new Error('Partial failure'))
                            return
                        }

                        const payloadData = Array.isArray(res.data) ? res.data[index] : undefined
                        task.deferred.resolve(payloadData as any)
                    })
                }
            } catch (error: any) {
                this.config.onError?.(toError(error), { lane: 'write', opCount: ops.length })
                // request 级失败：对本次已摘出的 items 全部 reject（write 策略不做 fallback）
                for (const slice of slicesByOpId.values()) {
                    slice.forEach(t => t.deferred.reject(this.disposed ? this.disposedError : error))
                }
            } finally {
                if (controller) this.inFlightControllers.delete(controller)
                for (const slice of slicesByOpId.values()) {
                    slice.forEach(t => this.inFlightTasks.delete(t as any))
                }
                this.writeInFlight--
            }
        }

        if (!this.disposed && (this.writeReady.length || hasPendingBuckets(this.writeBuckets))) {
            this.signalWriteLane()
        }
    }

    private async runQueryFallback<T>(task: QueryTask<T>, reason?: any) {
        try {
            const res = await task.fallback()
            task.deferred.resolve(normalizeQueryFallback(res))
        } catch (fallbackError) {
            task.deferred.reject(fallbackError ?? reason)
        }
    }

    private async send(payload: any, signal?: AbortSignal) {
        const headers = await this.resolveHeaders()
        const response = await this.fetcher(this.endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...headers
            },
            body: JSON.stringify(payload),
            signal
        })

        if (!response.ok) {
            throw new Error(`Batch request failed: ${response.status} ${response.statusText}`)
        }

        return response.json()
    }

    private async resolveHeaders(): Promise<Record<string, string>> {
        if (!this.config.headers) return {}
        const h = this.config.headers()
        return h instanceof Promise ? await h : h
    }

    private nextOpId(prefix: 'q' | 'w') {
        return `${prefix}_${Date.now()}_${this.seq++}`
    }

    private normalizeMaxQueueLength(lane: 'query' | 'write') {
        const cfg = this.config.maxQueueLength
        if (typeof cfg === 'number') {
            return normalizePositiveInt(cfg) ?? Infinity
        }
        if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
            const v = lane === 'query' ? (cfg as any).query : (cfg as any).write
            return normalizePositiveInt(v) ?? Infinity
        }
        return Infinity
    }

    private isWriteQueueFull() {
        const maxLen = this.normalizeMaxQueueLength('write')
        if (maxLen === Infinity) return false
        return this.writePendingCount >= maxLen
    }

    private normalizeMaxBatchSize() {
        const n = this.config.maxBatchSize
        return (typeof n === 'number' && Number.isFinite(n) && n > 0) ? Math.floor(n) : Infinity
    }

    private normalizeMaxOpsPerRequest() {
        const n = this.config.maxOpsPerRequest
        return (typeof n === 'number' && Number.isFinite(n) && n > 0) ? Math.floor(n) : Infinity
    }

    private normalizeMaxQueryOpsPerRequest() {
        const a = this.normalizeMaxBatchSize()
        const b = this.normalizeMaxOpsPerRequest()
        return Math.min(a, b)
    }
}

function bucketKey(task: WriteTask) {
    const action =
        task.kind === 'create' ? 'bulkCreate'
            : task.kind === 'update' ? 'bulkUpdate'
                : task.kind === 'patch' ? 'bulkPatch'
                    : 'bulkDelete'
    return `${action}:${task.resource}`
}

function buildWriteOp(opId: string, key: string, tasks: WriteTask[]) {
    const [action, resource] = key.split(':', 2)
    const payload = tasks.map(t => {
        if (t.kind === 'create') return t.item
        if (t.kind === 'update') return t.item
        if (t.kind === 'patch') return t.item
        return t.id
    })

    return {
        opId,
        action,
        resource,
        payload
    }
}

function mapResults(results: any): Map<string, BatchOpResult> {
    const map = new Map<string, BatchOpResult>()
    if (!Array.isArray(results)) return map
    results.forEach((r: any) => {
        if (r && typeof r.opId === 'string') map.set(r.opId, r as BatchOpResult)
    })
    return map
}

function normalizeQueryEnvelope<T>(res: BatchOpResult): { data: T[]; pageInfo?: PageInfo } | T[] {
    // server 返回 data[] + pageInfo；为了兼容旧调用方，保留 T[] | {data,pageInfo}
    if (Array.isArray(res.data)) {
        return res.pageInfo ? { data: res.data as T[], pageInfo: res.pageInfo } : (res.data as T[])
    }
    return res.pageInfo ? { data: [], pageInfo: res.pageInfo } : []
}

function normalizeQueryFallback<T>(res: any): { data: T[]; pageInfo?: PageInfo } | T[] {
    if (Array.isArray(res)) return res
    if (Array.isArray(res?.data)) return { data: res.data, pageInfo: res.pageInfo }
    return { data: [], pageInfo: res?.pageInfo }
}

function toError(err: any) {
    return err instanceof Error ? err : new Error(String(err))
}

function createAbortController() {
    if (typeof AbortController === 'undefined') return undefined
    return new AbortController()
}

function clampInt(v: number, min: number, max: number) {
    if (!Number.isFinite(v)) return min
    const n = Math.floor(v)
    if (n < min) return min
    if (n > max) return max
    return n
}

function hasPendingBuckets(map: Map<string, WriteTask[]>) {
    for (const tasks of map.values()) {
        if (tasks.length) return true
    }
    return false
}

function normalizePositiveInt(value: any) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
    return Math.floor(value)
}

function normalizeAtomaServerQueryParams<T>(input: FindManyOptions<T> | undefined) {
    const params: any = (input && typeof input === 'object') ? { ...input } : {}

    // sparse fieldset alias: FindManyOptions.fields -> server QueryParams.select
    if (Array.isArray(params.fields) && params.fields.length) {
        const select: Record<string, boolean> = (params.select && typeof params.select === 'object' && !Array.isArray(params.select))
            ? { ...params.select }
            : {}
        params.fields.forEach((f: any) => {
            if (typeof f === 'string' && f) select[f] = true
        })
        params.select = Object.keys(select).length ? select : undefined
        delete params.fields
    }

    // 若调用方已显式提供 server 侧 QueryParams（含 page），直接透传
    if (params.page && typeof params.page === 'object' && (params.page.mode === 'offset' || params.page.mode === 'cursor')) {
        if (params.orderBy && !Array.isArray(params.orderBy)) {
            params.orderBy = [params.orderBy]
        }
        return params
    }

    // FindManyOptions.orderBy 支持 object | array；server 协议要求数组
    if (params.orderBy && !Array.isArray(params.orderBy)) {
        params.orderBy = [params.orderBy]
    }

    const limit = typeof params.limit === 'number' ? params.limit : 50
    const offset = typeof params.offset === 'number' ? params.offset : undefined
    const includeTotal = typeof params.includeTotal === 'boolean' ? params.includeTotal : undefined

    const before = typeof params.before === 'string' ? params.before : undefined
    const after = typeof params.after === 'string' ? params.after : undefined
    const cursor = typeof params.cursor === 'string' ? params.cursor : undefined

    if (before || after || cursor) {
        params.page = {
            mode: 'cursor',
            limit,
            before,
            after: after ?? cursor
        }
    } else {
        params.page = {
            mode: 'offset',
            limit,
            offset,
            ...(includeTotal !== undefined ? { includeTotal } : {})
        }
    }

    // 防止旧字段误导：server REST/Batch 协议不使用 cursor（走 page.after/before）
    delete params.cursor
    delete params.limit
    delete params.offset
    delete params.includeTotal
    delete params.before
    delete params.after

    return params
}
