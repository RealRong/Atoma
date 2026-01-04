import { describe, expect, it, vi } from 'vitest'
import { createAtomaHandlers } from '../../src/server/createAtomaHandlers'
import { createError } from '../../src/server/error'

describe('atoma/server create', () => {
    it('client-id create: passes entityId to adapter create and returns same id', async () => {
        const create = vi.fn(async (_resource: string, data: any) => {
            expect(data.id).toBe('p1')
            expect(typeof data.version).toBe('number')
            return { data: { ...data, title: 'ok' } }
        })

        const orm: any = {
            create,
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
                            action: 'create',
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
        const itemRes = json.data.results[0].data.results[0]
        expect(itemRes.ok).toBe(true)
        expect(itemRes.entityId).toBe('p1')
        expect(create).toHaveBeenCalledTimes(1)
    })

    it('client-id create: rejects when entityId !== value.id', async () => {
        const create = vi.fn(async () => {
            throw new Error('should not call adapter')
        })

        const orm: any = {
            create,
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
                            action: 'create',
                            items: [
                                {
                                    entityId: 'p1',
                                    value: { id: 'p2', title: 'hi' }
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
        expect(itemRes.error.code).toBe('INVALID_WRITE')
        expect(create).toHaveBeenCalledTimes(0)
    })

    it('client-id create: fails if adapter returns mismatched id', async () => {
        const create = vi.fn(async (_resource: string, _data: any) => {
            return { data: { id: 'server', version: 1 } }
        })

        const orm: any = {
            create,
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
                            action: 'create',
                            items: [
                                {
                                    entityId: 'p1',
                                    value: { id: 'p1', title: 'hi' }
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
        expect(itemRes.error.code).toBe('INTERNAL')
        expect(create).toHaveBeenCalledTimes(1)
    })

    it('server-id create: allows missing entityId and returns server-generated id', async () => {
        const create = vi.fn(async (_resource: string, _data: any) => {
            return { data: { id: 's1', title: 'ok', version: 1 } }
        })

        const orm: any = {
            create,
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
                            action: 'create',
                            items: [
                                {
                                    value: { title: 'hi' }
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
        expect(itemRes.ok).toBe(true)
        expect(itemRes.entityId).toBe('s1')
        expect(create).toHaveBeenCalledTimes(1)
    })

    it('server-id create: still rejects if entityId provided but mismatches value.id', async () => {
        const create = vi.fn(async () => {
            throw createError('INTERNAL', 'should not call create', { kind: 'internal' })
        })

        const orm: any = {
            create,
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
                            action: 'create',
                            items: [
                                {
                                    entityId: 'p1',
                                    value: { id: 'p2', title: 'hi' }
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
        expect(itemRes.error.code).toBe('INVALID_WRITE')
        expect(create).toHaveBeenCalledTimes(0)
    })
})

