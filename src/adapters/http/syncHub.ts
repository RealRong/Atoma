import { makeUrl } from './request'
import { createSyncCursorStorage } from './syncCursor'
import { SYNC_SSE_EVENT_CHANGES } from '../../protocol/sync'
import type { AtomaChange, SyncSubscribeEvent } from '../../protocol/sync'

type Handler = (changes: AtomaChange[]) => void | Promise<void>

function buildUrlWithCursor(url: string, cursor: number) {
    const sep = url.includes('?') ? '&' : '?'
    return `${url}${sep}cursor=${encodeURIComponent(String(cursor))}`
}

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

export type SyncHubConfig = {
    baseURL: string
    endpoints: {
        pull: string
        subscribe: string
    }
    mode: 'sse' | 'poll'
    pollIntervalMs: number
    pullLimit: number
    cursorKey?: string
    deviceIdKey?: string
    getHeaders?: () => Promise<Record<string, string>>
    fetchFn?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    buildSubscribeUrl?: (args: { url: string; cursor: number; headers: Record<string, string> }) => string | Promise<string>
    eventSourceFactory?: (args: { url: string; headers: Record<string, string> }) => EventSource
}

export class SyncHub {
    private handlersByResource = new Map<string, Set<Handler>>()
    private started = false
    private stopping = false
    private cursor = 0

    private eventSource: EventSource | null = null
    private pollTimer: any = null
    private pullInFlight: Promise<void> | null = null

    private cursorStorage = createSyncCursorStorage({
        baseKey: `atoma:sync:${this.config.baseURL}`,
        cursorKey: this.config.cursorKey,
        deviceIdKey: this.config.deviceIdKey
    })

    constructor(private config: SyncHubConfig) { }

    async getOrCreateDeviceId(): Promise<string> {
        return this.cursorStorage.getOrCreateDeviceId()
    }

    async pullNow(): Promise<void> {
        // 允许在未 start 的情况下做一次性 pull（用于重连前置 pull）
        if (!this.started && this.cursor <= 0) {
            this.cursor = await this.cursorStorage.getCursor()
        }
        await this.pullOnce()
    }

    async advanceCursor(cursor: number): Promise<void> {
        const n = Number(cursor)
        if (!Number.isFinite(n) || n <= 0) return
        if (n > this.cursor) {
            this.cursor = Math.floor(n)
            await this.cursorStorage.setCursor(this.cursor)
        }
    }

    register(resource: string, handler: Handler) {
        if (!this.handlersByResource.has(resource)) {
            this.handlersByResource.set(resource, new Set())
        }
        this.handlersByResource.get(resource)!.add(handler)
        if (this.config.mode === 'sse' || this.config.mode === 'poll') {
            void this.start()
        }
    }

    unregister(resource: string, handler: Handler) {
        const set = this.handlersByResource.get(resource)
        if (!set) return
        set.delete(handler)
        if (!set.size) this.handlersByResource.delete(resource)
        if (!this.handlersByResource.size) {
            this.stop()
        }
    }

    stop() {
        this.stopping = true
        this.started = false
        if (this.eventSource) {
            try {
                this.eventSource.close()
            } catch {
                // ignore
            }
            this.eventSource = null
        }
        if (this.pollTimer) {
            clearInterval(this.pollTimer)
            this.pollTimer = null
        }
    }

    async start() {
        if (this.started) return
        if (!this.handlersByResource.size) return
        if (this.stopping) this.stopping = false

        this.cursor = await this.cursorStorage.getCursor()
        this.started = true

        if (this.config.mode === 'poll') {
            this.startPoll()
            return
        }

        const hasEventSource = typeof EventSource !== 'undefined' || typeof this.config.eventSourceFactory === 'function'
        if (!hasEventSource) {
            this.startPoll()
            return
        }

        void this.startSse()
    }

    requestPullSoon() {
        if (!this.started) return
        if (this.config.mode !== 'poll') return
        void this.pullOnce()
    }

    private startPoll() {
        const interval = Math.max(250, this.config.pollIntervalMs)
        this.pollTimer = setInterval(() => {
            void this.pullOnce()
        }, interval)
        void this.pullOnce()
    }

    private async startSse() {
        if (this.eventSource) return
        const subscribeUrl = makeUrl(this.config.baseURL, this.config.endpoints.subscribe)
        const headers = this.config.getHeaders ? await this.config.getHeaders() : {}
        const url = await (async () => {
            if (this.config.buildSubscribeUrl) {
                const built = await this.config.buildSubscribeUrl({ url: subscribeUrl, cursor: this.cursor, headers })
                return typeof built === 'string' && built ? built : buildUrlWithCursor(subscribeUrl, this.cursor)
            }
            return buildUrlWithCursor(subscribeUrl, this.cursor)
        })().catch(() => buildUrlWithCursor(subscribeUrl, this.cursor))

        let es: EventSource
        try {
            es = this.config.eventSourceFactory
                ? this.config.eventSourceFactory({ url, headers })
                : new EventSource(url)
        } catch {
            // SSE 无法建立（常见原因：需要 headers 但无 polyfill），fallback 到 poll
            this.startPoll()
            return
        }
        this.eventSource = es

        es.addEventListener(SYNC_SSE_EVENT_CHANGES, (evt: any) => {
            try {
                const data = typeof evt?.data === 'string' ? JSON.parse(evt.data) as SyncSubscribeEvent : undefined
                if (!data || typeof data.cursor !== 'number' || !Array.isArray(data.changes)) return
                void this.onIncoming(data.changes, data.cursor)
            } catch {
                // ignore malformed event
            }
        })

        es.addEventListener('error', () => {
            if (this.stopping) return
            try {
                es.close()
            } catch {
                // ignore
            }
            this.eventSource = null
            void this.reconnectSse()
        })
    }

    private async reconnectSse() {
        // 简单指数退避
        let backoff = 500
        while (this.started && !this.stopping && !this.eventSource) {
            await sleep(backoff)
            if (!this.started || this.stopping) return
            await this.startSse()
            backoff = Math.min(10_000, backoff * 2)
        }
    }

    private async pullOnce() {
        if (this.pullInFlight) return this.pullInFlight
        const run = async () => {
            const fetchFn = this.config.fetchFn ?? fetch
            const pullUrl = makeUrl(this.config.baseURL, this.config.endpoints.pull)
            const url = `${pullUrl}?cursor=${encodeURIComponent(String(this.cursor))}&limit=${encodeURIComponent(String(this.config.pullLimit))}`

            const headers = this.config.getHeaders ? await this.config.getHeaders() : {}
            const res = await fetchFn(url, { method: 'GET', headers })
            if (!res.ok) return
            const json = await res.json().catch(() => null)
            const changes = Array.isArray((json as any)?.changes)
                ? ((json as any).changes as AtomaChange[])
                : (Array.isArray(json) ? json as AtomaChange[] : [])

            const nextCursor = typeof (json as any)?.nextCursor === 'number'
                ? Number((json as any).nextCursor)
                : (typeof changes[changes.length - 1]?.cursor === 'number' ? Number(changes[changes.length - 1].cursor) : undefined)

            if (typeof nextCursor === 'number' && Number.isFinite(nextCursor) && nextCursor > 0) {
                await this.onIncoming(changes, nextCursor)
            }
        }
        this.pullInFlight = run().finally(() => { this.pullInFlight = null })
        return this.pullInFlight
    }

    private async onIncoming(changes: AtomaChange[], cursor: number) {
        const prevCursor = this.cursor

        // 丢弃过期事件：push ack 已推进 cursor 后仍可能收到旧 SSE（或 poll 重复）
        if (typeof cursor === 'number' && cursor <= prevCursor) return

        if (typeof cursor === 'number' && cursor > prevCursor) {
            this.cursor = cursor
            await this.cursorStorage.setCursor(this.cursor)
        }

        if (!changes.length) return

        const filtered = prevCursor > 0
            ? changes.filter(c => typeof c?.cursor !== 'number' || c.cursor > prevCursor)
            : changes

        if (!filtered.length) return

        const grouped = new Map<string, AtomaChange[]>()
        for (const c of filtered) {
            if (!c || typeof c.resource !== 'string' || !c.resource) continue
            if (!grouped.has(c.resource)) grouped.set(c.resource, [])
            grouped.get(c.resource)!.push(c)
        }

        await Promise.all(Array.from(grouped.entries()).map(async ([resource, list]) => {
            const handlers = this.handlersByResource.get(resource)
            if (!handlers || !handlers.size) return
            await Promise.all(Array.from(handlers.values()).map(h => Promise.resolve(h(list))))
        }))
    }
}

const hubs = new Map<string, SyncHub>()

export function getSyncHub(key: string, create: () => SyncHub): SyncHub {
    const existing = hubs.get(key)
    if (existing) return existing
    const hub = create()
    hubs.set(key, hub)
    return hub
}
