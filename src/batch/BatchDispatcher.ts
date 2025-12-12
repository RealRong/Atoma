import type { FindManyOptions, PageInfo, StoreKey } from '../core/types'

type FetchFn = typeof fetch

export interface BatchDispatcherConfig {
    /** 批量端点，默认 /api/batch */
    endpoint?: string
    /** 自定义 headers（可异步获取 token） */
    headers?: () => Promise<Record<string, string>> | Record<string, string>
    /** 自定义 fetch（便于 polyfill 或注入超时） */
    fetchFn?: FetchFn
    /** 批量大小阈值，达到后立即 flush；默认无限制 */
    maxBatchSize?: number
    /** 额外延迟 flush 的毫秒数；默认 0（同一事件循环聚合） */
    flushIntervalMs?: number
    /** 批量请求失败时的回调，用于埋点或日志 */
    onError?: (error: Error, payload: any) => void
}

type QueryTask<T> = {
    type: 'query'
    resource: string
    params: FindManyOptions<T> | undefined
    requestId: string
    fallback: () => Promise<{ data: T[]; pageInfo?: PageInfo } | T[]>
    resolve: (value: { data: T[]; pageInfo?: PageInfo } | T[]) => void
    reject: (reason?: any) => void
}

type CreateTask<T> = {
    type: 'create'
    resource: string
    item: T
    fallback: () => Promise<any>
    resolve: (value?: any) => void
    reject: (reason?: any) => void
}

type UpdateTask<T> = {
    type: 'update'
    resource: string
    item: { id: StoreKey; data: T; clientVersion?: any }
    fallback: () => Promise<void>
    resolve: (value?: any) => void
    reject: (reason?: any) => void
}

type PatchTask<T> = {
    type: 'patch'
    resource: string
    item: { id: StoreKey; patches: any[]; baseVersion?: number; timestamp?: number }
    fallback: () => Promise<void>
    resolve: (value?: any) => void
    reject: (reason?: any) => void
}

type DeleteTask = {
    type: 'delete'
    resource: string
    id: StoreKey
    fallback: () => Promise<void>
    resolve: () => void
    reject: (reason?: any) => void
}

 type PendingTask<T> = QueryTask<T> | CreateTask<T> | UpdateTask<T> | PatchTask<T> | DeleteTask

export class BatchDispatcher {
    private queue: PendingTask<any>[] = []
    private scheduled = false
    private disposed = false
    private seq = 0
    private readonly endpoint: string
    private readonly fetcher: FetchFn
    private timer?: ReturnType<typeof setTimeout>

    constructor(private readonly config: BatchDispatcherConfig = {}) {
        this.endpoint = (config.endpoint || '/api/batch').replace(/\/$/, '')
        this.fetcher = config.fetchFn ?? fetch
    }

    enqueueQuery<T>(
        resource: string,
        params: FindManyOptions<T> | undefined,
        fallback: () => Promise<{ data: T[]; pageInfo?: PageInfo } | T[]>
    ): Promise<{ data: T[]; pageInfo?: PageInfo } | T[]> {
        return new Promise((resolve, reject) => {
            const requestId = `${Date.now()}_${this.seq++}`
            this.pushTask({ type: 'query', resource, params, requestId, fallback, resolve, reject })
        })
    }

    enqueueCreate<T>(
        resource: string,
        item: T,
        fallback: () => Promise<any>
    ): Promise<any> {
        return new Promise((resolve, reject) => {
            this.pushTask({ type: 'create', resource, item, fallback, resolve, reject })
        })
    }

    enqueueUpdate<T>(
        resource: string,
        item: { id: StoreKey; data: T; clientVersion?: any },
        fallback: () => Promise<void>
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            this.pushTask({ type: 'update', resource, item, fallback, resolve, reject })
        })
    }

    enqueuePatch(
        resource: string,
        item: { id: StoreKey; patches: any[]; baseVersion?: number; timestamp?: number },
        fallback: () => Promise<void>
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            this.pushTask({ type: 'patch', resource, item, fallback, resolve, reject })
        })
    }

    enqueueDelete(
        resource: string,
        id: StoreKey,
        fallback: () => Promise<void>
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            this.pushTask({ type: 'delete', resource, id, fallback, resolve, reject })
        })
    }

    dispose() {
        this.disposed = true
        this.scheduled = false
        if (this.timer) {
            clearTimeout(this.timer)
            this.timer = undefined
        }

        const pending = this.queue.splice(0, this.queue.length)
        if (pending.length) {
            const error = new Error('BatchDispatcher disposed')
            pending.forEach(task => task.reject(error))
        }
    }

    private pushTask(task: PendingTask<any>) {
        if (this.disposed) {
            task.reject(new Error('BatchDispatcher disposed'))
            return
        }

        this.queue.push(task)

        if (this.config.maxBatchSize && this.queue.length >= this.config.maxBatchSize) {
            this.flush()
            return
        }

        if (!this.scheduled) {
            this.scheduled = true
            const delay = this.config.flushIntervalMs ?? 0
            if (delay > 0) {
                this.timer = setTimeout(() => this.flush(), delay)
            } else {
                queueMicrotask(() => this.flush())
            }
        }
    }

    private async flush() {
        if (this.disposed) return
        this.scheduled = false
        if (this.timer) {
            clearTimeout(this.timer)
            this.timer = undefined
        }
        if (!this.queue.length) return

        const buckets = new Map<string, { type: PendingTask<any>['type']; resource: string; tasks: PendingTask<any>[] }>()

        while (this.queue.length) {
            const task = this.queue.shift()!
            const key = `${task.type}:${task.resource}`
            const bucket = buckets.get(key) ?? { type: task.type, resource: task.resource, tasks: [] }
            bucket.tasks.push(task)
            buckets.set(key, bucket)
        }

        const max = this.config.maxBatchSize && this.config.maxBatchSize > 0 ? this.config.maxBatchSize : Infinity

        for (const bucket of buckets.values()) {
            const tasks = bucket.tasks
            for (let i = 0; i < tasks.length; i += max) {
                const slice = tasks.slice(i, i + max)
                try {
                    switch (bucket.type) {
                        case 'query':
                            await this.flushQueries(slice as QueryTask<any>[])
                            break
                        case 'create':
                            await this.flushWrites('bulkCreate', bucket.resource, slice as CreateTask<any>[], t => t.item)
                            break
                        case 'update':
                            await this.flushWrites('bulkUpdate', bucket.resource, slice as UpdateTask<any>[], t => t.item)
                            break
                        case 'patch':
                            await this.flushWrites('bulkPatch', bucket.resource, slice as PatchTask<any>[], t => t.item)
                            break
                        case 'delete':
                            await this.flushWrites('bulkDelete', bucket.resource, slice as DeleteTask[], t => t.id)
                            break
                    }
                } catch (error: any) {
                    this.config.onError?.(error instanceof Error ? error : new Error(String(error)), {
                        type: bucket.type,
                        resource: bucket.resource
                    })
                    slice.forEach(task => this.runFallback(task, error))
                }
            }
        }
    }

    private async flushQueries(tasks: QueryTask<any>[]) {
        const payload = {
            action: 'query',
            queries: tasks.map(item => ({
                resource: item.resource,
                requestId: item.requestId,
                params: item.params ?? {}
            }))
        }

        try {
            const response = await this.send(payload)
            const resultMap = new Map<string, { data: any[]; pageInfo?: PageInfo; error?: any }>()
            Array.isArray(response?.results) && response.results.forEach((r: any) => {
                resultMap.set(r.requestId ?? '', r)
            })

            tasks.forEach(item => {
                const res = resultMap.get(item.requestId)
                if (!res || res.error) {
                    this.runFallback(item, res?.error)
                    return
                }
                const normalized = this.normalize(res)
                item.resolve(normalized)
            })
        } catch (error) {
            tasks.forEach(item => this.runFallback(item, error))
        }
    }

    private async flushWrites<T extends CreateTask<any> | UpdateTask<any> | PatchTask<any> | DeleteTask>(
        action: 'bulkCreate' | 'bulkUpdate' | 'bulkPatch' | 'bulkDelete',
        resource: string,
        tasks: T[],
        toPayload: (task: T) => any
    ) {
        const payload = {
            action,
            resource,
            payload: tasks.map(toPayload)
        }

        try {
            const response = await this.send(payload)
            const result = Array.isArray(response?.results) ? response.results[0] : undefined
            if (!result) {
                throw new Error('Empty batch result')
            }

            const failures = new Set<number>()
            result.partialFailures?.forEach((f: any) => failures.add(f.index))

            tasks.forEach((task, index) => {
                if (failures.has(index)) {
                    const failure = result.partialFailures?.find((f: any) => f.index === index)
                    task.reject(failure?.error ?? new Error('Partial failure'))
                    return
                }
                const payloadData = Array.isArray(result.data) ? result.data[index] : undefined
                task.resolve(payloadData)
            })
        } catch (error) {
            tasks.forEach(task => this.runFallback(task, error))
        }
    }

    private async send(payload: any) {
        const headers = await this.resolveHeaders()
        const response = await this.fetcher(this.endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...headers
            },
            body: JSON.stringify(payload)
        })

        if (!response.ok) {
            throw new Error(`Batch request failed: ${response.status} ${response.statusText}`)
        }

        return response.json()
    }

    private async runFallback<T>(item: PendingTask<T>, reason?: any) {
        try {
            if (item.type === 'query') {
                const res = await item.fallback()
                item.resolve(this.normalize(res))
                return
            }
            const val = await item.fallback()
            item.resolve(val)
        } catch (fallbackError) {
            item.reject(fallbackError ?? reason)
        }
    }

    private normalize<T>(res: any): { data: T[]; pageInfo?: PageInfo } | T[] {
        if (Array.isArray(res)) return res
        if (Array.isArray(res?.data)) return { data: res.data, pageInfo: res.pageInfo }
        return { data: [], pageInfo: res?.pageInfo }
    }

    private async resolveHeaders(): Promise<Record<string, string>> {
        if (!this.config.headers) return {}
        const h = this.config.headers()
        return h instanceof Promise ? await h : h
    }
}
