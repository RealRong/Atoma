import { describe, expect, it, vi } from 'vitest'
import { createAtomaHandlers } from '../../src/server/createAtomaHandlers'
import { createError } from '../../src/server/error'

describe('atoma/server upsert', () => {
    it('forces returning=true for upsert (even when request returning=false)', async () => {
        const upsert = vi.fn(async (_resource: string, item: any, options: any) => {
            if (options?.returning !== true) {
                throw new Error('expected options.returning === true for upsert')
            }
            return { data: { id: item.id, title: 'ok', version: 2 } }
        })

        const orm: any = {
            upsert,
            transaction: async (fn: any) => fn({ orm, tx: undefined })
        }

        const handlers = createAtomaHandlers({
            adapter: { orm, sync: {} as any },
            sync: { enabled: false }
        })

        const req = new Request('http://localhost/ops', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                meta: { v: 1 },
                ops: [
                    {
                        opId: 'w1',
                        kind: 'write',
                        write: {
                            resource: 'posts',
                            action: 'upsert',
                            options: { returning: false, upsert: { mode: 'strict' } },
                            items: [
                                {
                                    entityId: 'p1',
                                    baseVersion: 1,
                                    value: { id: 'p1', title: 'hi', version: 1 },
                                    meta: { idempotencyKey: 'k1', clientTimeMs: 1 }
                                }
                            ]
                        }
                    }
                ]
            })
        })

        const res = await handlers.ops(req)
        expect(res.status).toBe(200)
        const json = await res.json()

        const opRes = json.data.results[0]
        expect(opRes.ok).toBe(true)
        expect(opRes.data.results[0].ok).toBe(true)
        expect(opRes.data.results[0].entityId).toBe('p1')
        expect(opRes.data.results[0].version).toBe(2)
        expect(upsert).toHaveBeenCalledTimes(1)
    })

    it('passes upsert.mode=loose to adapter', async () => {
        const upsert = vi.fn(async (_resource: string, item: any) => {
            if (item?.mode !== 'loose') {
                throw new Error(`expected item.mode === 'loose', got ${String(item?.mode)}`)
            }
            return { data: { id: item.id, version: 1 } }
        })

        const orm: any = {
            upsert,
            transaction: async (fn: any) => fn({ orm, tx: undefined })
        }

        const handlers = createAtomaHandlers({
            adapter: { orm, sync: {} as any },
            sync: { enabled: false }
        })

        const req = new Request('http://localhost/ops', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                meta: { v: 1 },
                ops: [
                    {
                        opId: 'w1',
                        kind: 'write',
                        write: {
                            resource: 'posts',
                            action: 'upsert',
                            options: { upsert: { mode: 'loose' } },
                            items: [
                                {
                                    entityId: 'p1',
                                    value: { id: 'p1', title: 'hi' },
                                    meta: { idempotencyKey: 'k1', clientTimeMs: 1 }
                                }
                            ]
                        }
                    }
                ]
            })
        })

        const res = await handlers.ops(req)
        expect(res.status).toBe(200)
        const json = await res.json()
        expect(json.data.results[0].ok).toBe(true)
        expect(json.data.results[0].data.results[0].ok).toBe(true)
        expect(upsert).toHaveBeenCalledTimes(1)
    })

    it('returns CONFLICT + current for strict upsert', async () => {
        const upsert = vi.fn(async (resource: string, _item: any) => {
            throw createError('CONFLICT', 'Version conflict', {
                kind: 'conflict',
                resource,
                currentVersion: 5,
                currentValue: { id: 'p1', title: 'server', version: 5 }
            })
        })

        const orm: any = {
            upsert,
            transaction: async (fn: any) => fn({ orm, tx: undefined })
        }

        const handlers = createAtomaHandlers({
            adapter: { orm, sync: {} as any },
            sync: { enabled: false }
        })

        const req = new Request('http://localhost/ops', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                meta: { v: 1 },
                ops: [
                    {
                        opId: 'w1',
                        kind: 'write',
                        write: {
                            resource: 'posts',
                            action: 'upsert',
                            options: { upsert: { mode: 'strict' } },
                            items: [
                                {
                                    entityId: 'p1',
                                    baseVersion: 4,
                                    value: { id: 'p1', title: 'client', version: 4 },
                                    meta: { idempotencyKey: 'k1', clientTimeMs: 1 }
                                }
                            ]
                        }
                    }
                ]
            })
        })

        const res = await handlers.ops(req)
        expect(res.status).toBe(200)
        const json = await res.json()

        const itemRes = json.data.results[0].data.results[0]
        expect(itemRes.ok).toBe(false)
        expect(itemRes.error.code).toBe('CONFLICT')
        expect(itemRes.current.version).toBe(5)
        expect(itemRes.current.value).toEqual({ id: 'p1', title: 'server', version: 5 })
        expect(upsert).toHaveBeenCalledTimes(1)
    })
})

