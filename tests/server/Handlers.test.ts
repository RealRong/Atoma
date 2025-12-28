import { describe, expect, it, vi } from 'vitest'
import { createAtomaHandlers } from '../../src/server/createAtomaHandlers'
import { createError } from '../../src/server/error'

describe('atoma/server createAtomaHandlers', () => {
    it('handles ops(Request) and returns an envelope response', async () => {
        const findMany = vi.fn(async () => ({ data: [{ id: '1', title: 'a' }] }))
        const orm: any = {
            findMany,
            transaction: async (fn: any) => fn({ orm, tx: undefined })
        }

        const handlers = createAtomaHandlers({
            adapter: {
                orm: {
                    findMany,
                    transaction: orm.transaction
                } as any,
                sync: {} as any
            },
            sync: { enabled: false }
        })

        const req = new Request('http://localhost/ops', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                meta: { v: 1 },
                ops: [
                    {
                        opId: 'q1',
                        kind: 'query',
                        query: { resource: 'todos', params: {} }
                    }
                ]
            })
        })

        const res = await handlers.ops(req)
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toContain('application/json')

        const json = await res.json()
        expect(json.ok).toBe(true)
        expect(json.data.results[0].opId).toBe('q1')
        expect(json.data.results[0].ok).toBe(true)
        expect(json.data.results[0].data.items).toEqual([{ id: '1', title: 'a' }])
        expect(findMany).toHaveBeenCalledTimes(1)
    })

    it('runs op plugins and can deny before adapter execution', async () => {
        const findMany = vi.fn(async () => ({ data: [{ id: '1', secret: 'x' }] }))
        const orm: any = {
            findMany,
            transaction: async (fn: any) => fn({ orm, tx: undefined })
        }

        const handlers = createAtomaHandlers({
            adapter: {
                orm: {
                    findMany,
                    transaction: orm.transaction
                } as any,
                sync: {} as any
            },
            sync: { enabled: false },
            plugins: {
                op: [
                    async (ctx, next) => {
                        if (ctx.kind === 'query') {
                            return { ok: false, error: createError('ACCESS_DENIED', 'nope', { kind: 'auth' }) }
                        }
                        return next()
                    }
                ]
            }
        })

        const req = new Request('http://localhost/ops', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                meta: { v: 1 },
                ops: [
                    {
                        opId: 'q1',
                        kind: 'query',
                        query: { resource: 'todos', params: {} }
                    }
                ]
            })
        })

        const res = await handlers.ops(req)
        const json = await res.json()
        expect(json.ok).toBe(true)
        expect(json.data.results[0].opId).toBe('q1')
        expect(json.data.results[0].ok).toBe(false)
        expect(json.data.results[0].error.code).toBe('ACCESS_DENIED')
        expect(findMany).toHaveBeenCalledTimes(0)
    })

    it('handles subscribe(Request) and streams SSE', async () => {
        const ac = new AbortController()
        let calls = 0
        const orm: any = {
            findMany: async () => ({ data: [] }),
            transaction: async (fn: any) => fn({ orm, tx: undefined })
        }

        const handlers = createAtomaHandlers({
            adapter: {
                orm: {
                    findMany: orm.findMany,
                    transaction: orm.transaction
                } as any,
                sync: {
                    getIdempotency: async () => ({ hit: false }),
                    putIdempotency: async () => {},
                    appendChange: async () => ({ cursor: 1, resource: 'todos', id: '1', kind: 'upsert', serverVersion: 1, changedAt: 1 }),
                    pullChanges: async () => [],
                    waitForChanges: async () => {
                        calls++
                        if (calls === 1) {
                            return [{ cursor: 1, resource: 'todos', id: '1', kind: 'upsert', serverVersion: 2, changedAt: 1 }]
                        }
                        return []
                    }
                }
            },
            sync: {
                enabled: true,
                subscribe: { heartbeatMs: 999999, retryMs: 1, maxHoldMs: 1 }
            }
        })

        const req = new Request('http://localhost/sync/subscribe-vnext?cursor=0', {
            method: 'GET',
            signal: ac.signal
        })

        const res = await handlers.subscribe(req)
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toContain('text/event-stream')

        const reader = res.body!.getReader()
        const decoder = new TextDecoder()

        const first = await reader.read()
        expect(first.done).toBe(false)
        expect(decoder.decode(first.value)).toContain('retry:')

        const second = await reader.read()
        expect(second.done).toBe(false)
        expect(decoder.decode(second.value)).toContain('event: changes')

        ac.abort()
        await reader.cancel()
    })
})
