import { FindManyOptions, IAdapter, PageInfo, PatchMetadata, StoreKey, Entity } from '../core/types'

export interface SQLiteHttpAdapterConfig {
    /** 基础 URL，如 http://localhost:8787 */
    baseURL: string
    /** 资源路径，默认 items -> /items */
    resourceName?: string
    /** 查询参数键名映射 */
    queryParams?: {
        limit?: string
        offset?: string
        cursor?: string
        q?: string
    }
    /** 自定义 fetch（可用于 polyfill 或注入超时） */
    fetchFn?: typeof fetch
}

type Envelope<T> = { data: T | T[]; pageInfo?: PageInfo }

/**
 * 极简 HTTP 适配器，面向 sqlite http 小服务：
 * - GET /items?limit&offset&cursor&q
 * - GET /items/:id
 * - POST /items
 * - PUT /items/:id
 * - DELETE /items/:id
 *
 * 目标：让大列表 demo/样例无需重复写样板。
 */
export class SQLiteHttpAdapter<T extends Entity> implements IAdapter<T> {
    public readonly name: string
    private readonly base: string
    private readonly resource: string
    private readonly qp: Required<NonNullable<SQLiteHttpAdapterConfig['queryParams']>>
    private readonly fetcher: typeof fetch

    constructor(private config: SQLiteHttpAdapterConfig) {
        this.base = config.baseURL.replace(/\/$/, '')
        this.resource = (config.resourceName ?? 'items').replace(/^\//, '')
        this.name = `sqlite-http:${this.resource}`
        this.qp = {
            limit: 'limit',
            offset: 'offset',
            cursor: 'cursor',
            q: 'q',
            ...config.queryParams
        }
        const f = config.fetchFn ?? fetch
        // 绑定到全局（Safari 等环境防止 this 绑定错误）
        this.fetcher = ((...args: Parameters<typeof fetch>) => f(...args)) as typeof fetch
    }

    private url(path = '', params?: URLSearchParams) {
        const suffix = path
            ? `${path.startsWith('/') ? '' : '/'}${path}`
            : ''
        const base = `${this.base}/${this.resource}${suffix}`
        return params ? `${base}?${params.toString()}` : base
    }

    private async jsonFetch(input: RequestInfo, init?: RequestInit) {
        const res = await this.fetcher(input, {
            headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
            ...init
        })
        if (!res.ok) {
            const text = await res.text().catch(() => '')
            throw new Error(`HTTP ${res.status}: ${text || res.statusText}`)
        }
        return res
    }

    async put(key: StoreKey, value: T): Promise<void> {
        await this.jsonFetch(this.url(String(key)), {
            method: 'PUT',
            body: JSON.stringify(value)
        })
    }

    async bulkPut(items: T[]): Promise<void> {
        await Promise.all(items.map(item => this.put(item.id, item)))
    }

    async delete(key: StoreKey): Promise<void> {
        await this.jsonFetch(this.url(String(key)), { method: 'DELETE' })
    }

    async bulkDelete(keys: StoreKey[]): Promise<void> {
        await Promise.all(keys.map(k => this.delete(k)))
    }

    async get(key: StoreKey): Promise<T | undefined> {
        try {
            const res = await this.jsonFetch(this.url(String(key)))
            return (await res.json()) as T
        } catch (error) {
            // 404 或其他错误视为 undefined（交给上层错误处理更合适时可调整）
            return undefined
        }
    }

    async bulkGet(keys: StoreKey[]): Promise<(T | undefined)[]> {
        return Promise.all(keys.map(k => this.get(k)))
    }

    async getAll(filter?: (item: T) => boolean): Promise<T[]> {
        const res = await this.jsonFetch(this.url('', new URLSearchParams({
            [this.qp.limit]: '500',
            [this.qp.offset]: '0'
        })))
        const json = (await res.json()) as Envelope<T>
        const arr = Array.isArray(json.data) ? json.data : [json.data]
        return filter ? arr.filter(filter) : arr
    }

    async findMany(options?: FindManyOptions<T>): Promise<{ data: T[]; pageInfo?: PageInfo } | T[]> {
        const params = new URLSearchParams()
        if (options?.limit !== undefined) params.set(this.qp.limit, String(options.limit))
        if (options?.offset !== undefined) params.set(this.qp.offset, String(options.offset))
        // cursor 仅作为 offset / key 的简单传递
        if ((options as any)?.cursor) params.set(this.qp.cursor, String((options as any).cursor))
        const where = (options?.where || {}) as any
        // 字段映射：字符串等值
        if (where.category) params.set('category', String(where.category))
        if (where.status) params.set('status', String(where.status))
        if (where.author) params.set('author', String(where.author))
        if (where.featured !== undefined) params.set('featured', where.featured ? '1' : '0')
        if (where.title?.contains) params.set(this.qp.q, String(where.title.contains))
        if (where.body?.contains) params.set(this.qp.q, String(where.body.contains))
        if (where.score?.gte !== undefined) params.set('minScore', String(where.score.gte))
        if (where.score?.lte !== undefined) params.set('maxScore', String(where.score.lte))
        // 简单文本搜索约定（备用）
        if ((options as any)?.q) params.set(this.qp.q, String((options as any).q))

        const res = await this.jsonFetch(this.url('', params))
        const json = (await res.json()) as Envelope<T>
        const data = Array.isArray(json.data) ? json.data : [json.data]
        return { data, pageInfo: json.pageInfo }
    }

    // sqlite http demo 不支持 patch 语义，留空即可
    async applyPatches(_patches: any[], _metadata: PatchMetadata): Promise<void> {
        throw new Error('[SQLiteHttpAdapter] applyPatches is not supported by this simple adapter.')
    }

    async onConnect(): Promise<void> { }
    onDisconnect(): void { }
    onError?(error: Error, operation: string): void {
        console.error(`[SQLiteHttpAdapter] ${operation}`, error)
    }
}
