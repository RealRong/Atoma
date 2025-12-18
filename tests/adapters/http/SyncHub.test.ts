import { describe, it, expect, vi, afterEach } from 'vitest'
import { SyncHub } from '../../../src/adapters/http/syncHub'

function flush() {
    return new Promise(resolve => setTimeout(resolve, 0))
}

describe('SyncHub', () => {
    afterEach(() => {
        vi.useRealTimers()
    })

    it('pull 优先使用 nextCursor，并且 changes 为空也会推进 cursor', async () => {
        const calls: string[] = []
        const fetchFn = vi.fn(async (input: any) => {
            calls.push(String(input))
            const body = calls.length === 1
                ? { nextCursor: 10, changes: [] }
                : { nextCursor: 10, changes: [] }
            return new Response(JSON.stringify(body), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            })
        })

        const hub = new SyncHub({
            baseURL: 'http://example.local/hub-next-cursor-empty',
            endpoints: { pull: '/sync/pull', subscribe: '/sync/subscribe' },
            mode: 'poll',
            pollIntervalMs: 10_000,
            pullLimit: 200,
            fetchFn
        })

        await hub.pullNow()
        await hub.pullNow()

        expect(calls[0]).toContain('cursor=0')
        expect(calls[1]).toContain('cursor=10')
        hub.stop()
    })

    it('pull 以 server 返回的 nextCursor 为准（覆盖 changes 最后一条的 cursor）', async () => {
        const calls: string[] = []
        const fetchFn = vi.fn(async (input: any) => {
            calls.push(String(input))
            const body = calls.length === 1
                ? { nextCursor: 100, changes: [{ resource: 'todos', id: 1, kind: 'patch', cursor: 50 }] }
                : { nextCursor: 100, changes: [] }
            return new Response(JSON.stringify(body), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            })
        })

        const hub = new SyncHub({
            baseURL: 'http://example.local/hub-next-cursor-prefer',
            endpoints: { pull: '/sync/pull', subscribe: '/sync/subscribe' },
            mode: 'poll',
            pollIntervalMs: 10_000,
            pullLimit: 200,
            fetchFn
        })

        await hub.pullNow()
        await hub.pullNow()

        expect(calls[0]).toContain('cursor=0')
        expect(calls[1]).toContain('cursor=100')
        hub.stop()
    })

    it('SSE 支持 buildSubscribeUrl + eventSourceFactory，并在 factory 抛错时 fallback 到 poll', async () => {
        const created: Array<{ url: string; headers: Record<string, string> }> = []
        const fetchCalls: string[] = []
        const fetchFn = vi.fn(async (input: any) => {
            fetchCalls.push(String(input))
            const body = { nextCursor: 1, changes: [] }
            return new Response(JSON.stringify(body), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            })
        })

        const buildSubscribeUrl = vi.fn(async (args: { url: string; cursor: number }) => {
            return `${args.url}?cursor=${args.cursor}&token=abc`
        })

        const hub = new SyncHub({
            baseURL: 'http://example.local/hub-sse',
            endpoints: { pull: '/sync/pull', subscribe: '/sync/subscribe' },
            mode: 'sse',
            pollIntervalMs: 250,
            pullLimit: 200,
            getHeaders: async () => ({ Authorization: 'Bearer abc' }),
            fetchFn,
            buildSubscribeUrl,
            eventSourceFactory: (args) => {
                created.push(args)
                throw new Error('no-sse')
            }
        })

        hub.register('todos', async () => { })
        await flush()

        expect(buildSubscribeUrl).toHaveBeenCalled()
        expect(created[0]?.url).toContain('cursor=0')
        expect(created[0]?.url).toContain('token=abc')
        expect(created[0]?.headers?.Authorization).toBe('Bearer abc')

        // factory 失败 -> poll fallback，会触发一次 pull
        await flush()
        expect(fetchCalls.length).toBeGreaterThan(0)

        hub.stop()
    })
})
