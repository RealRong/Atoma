import type { FindManyOptions, PageInfo } from '../core/types'

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

type PendingRequest<T> = {
    resource: string
    params: FindManyOptions<T> | undefined
    requestId: string
    fallback: () => Promise<{ data: T[]; pageInfo?: PageInfo } | T[]>
    resolve: (value: { data: T[]; pageInfo?: PageInfo } | T[]) => void
    reject: (reason?: any) => void
}

export class BatchDispatcher {
    private queue: PendingRequest<any>[] = []
    private scheduled = false
    private seq = 0
    private readonly endpoint: string
    private readonly fetcher: FetchFn

    constructor(private readonly config: BatchDispatcherConfig = {}) {
        this.endpoint = (config.endpoint || '/api/batch').replace(/\/$/, '')
        this.fetcher = config.fetchFn ?? fetch
    }

    /**
     * 将 findMany 请求入队，等待与同一 tick 的其他请求合并。
     * 失败时自动回退到传入的 fallback（通常是原始 adapter.findMany）。
     */
    enqueue<T>(
        resource: string,
        params: FindManyOptions<T> | undefined,
        fallback: () => Promise<{ data: T[]; pageInfo?: PageInfo } | T[]>
    ): Promise<{ data: T[]; pageInfo?: PageInfo } | T[]> {
        return new Promise((resolve, reject) => {
            const requestId = `${Date.now()}_${this.seq++}`
            this.queue.push({ resource, params, requestId, fallback, resolve, reject })

            if (this.config.maxBatchSize && this.queue.length >= this.config.maxBatchSize) {
                this.flush()
                return
            }

            if (!this.scheduled) {
                this.scheduled = true
                const delay = this.config.flushIntervalMs ?? 0
                if (delay > 0) {
                    setTimeout(() => this.flush(), delay)
                } else {
                    queueMicrotask(() => this.flush())
                }
            }
        })
    }

    private async flush() {
        this.scheduled = false
        if (!this.queue.length) return

        const batch = this.queue.splice(0, this.queue.length)
        const payload = {
            action: 'query',
            queries: batch.map(item => ({
                resource: item.resource,
                requestId: item.requestId,
                params: item.params ?? {}
            }))
        }

        try {
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

            const json = await response.json()
            const resultMap = new Map<string, { data: any[]; pageInfo?: PageInfo; error?: any }>()
            Array.isArray(json?.results) && json.results.forEach((r: any) => {
                resultMap.set(r.requestId ?? '', r)
            })

            batch.forEach(item => {
                const res = resultMap.get(item.requestId)
                if (!res || res.error) {
                    this.runFallback(item, res?.error)
                    return
                }
                const normalized = this.normalize(res)
                item.resolve(normalized)
            })
        } catch (error: any) {
            this.config.onError?.(error instanceof Error ? error : new Error(String(error)), payload)
            // 整批失败，逐个走 fallback，保持兼容
            batch.forEach(item => this.runFallback(item, error))
        }
    }

    private async runFallback<T>(item: PendingRequest<T>, reason?: any) {
        try {
            const res = await item.fallback()
            item.resolve(this.normalize(res))
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
