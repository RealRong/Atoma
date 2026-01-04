import { describe, expect, it, vi } from 'vitest'
import { createAtomaHandlers } from '../../src/server/createAtomaHandlers'

describe('atoma/server version contract', () => {
    it('bulk upsert(loose): forces select.version even when request select excludes it (and still returns version when returning=false)', async () => {
        let seenOptions: any = null

        const bulkUpsert = vi.fn(async (_resource: string, items: any[], options: any) => {
            seenOptions = options

            const resultsByIndex = items.map((it, idx) => {
                const row = { id: it.id, title: 'server', version: idx === 0 ? 9 : 11 }
                const selected = (options?.select && typeof options.select === 'object')
                    ? Object.fromEntries(Object.keys(options.select).filter(k => options.select[k]).map(k => [k, (row as any)[k]]))
                    : row
                return { ok: true, data: selected }
            })

            return { resultsByIndex, transactionApplied: false }
        })

        const upsert = vi.fn(async () => {
            throw new Error('should use bulkUpsert')
        })

        const orm: any = {
            bulkUpsert,
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
                            options: { returning: false, select: { title: true }, upsert: { mode: 'loose' } },
                            items: [
                                {
                                    entityId: 'p1',
                                    value: { id: 'p1', title: 'client' }
                                },
                                {
                                    entityId: 'p2',
                                    value: { id: 'p2', title: 'client2' }
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

        const results = json.data.results[0].data.results
        expect(Array.isArray(results)).toBe(true)
        expect(results).toHaveLength(2)
        expect(results[0].ok, JSON.stringify(results[0])).toBe(true)
        expect(results[0].entityId).toBe('p1')
        expect(results[0].version).toBe(9)
        expect(results[0].data).toBeUndefined()
        expect(results[1].ok, JSON.stringify(results[1])).toBe(true)
        expect(results[1].entityId).toBe('p2')
        expect(results[1].version).toBe(11)
        expect(results[1].data).toBeUndefined()
        expect(seenOptions?.returning).toBe(true)
        expect(seenOptions?.select?.version).toBe(true)
        expect(bulkUpsert).toHaveBeenCalledTimes(1)
        expect(upsert).toHaveBeenCalledTimes(0)
    })

    it('bulk create(server-id): forces select.id even when request select excludes it', async () => {
        let seenOptions: any = null

        const bulkCreate = vi.fn(async (_resource: string, items: any[], options: any) => {
            seenOptions = options

            const resultsByIndex = items.map((_it, idx) => {
                const row = { id: `s${idx + 1}`, title: 'server', version: 1 }
                const selected = (options?.select && typeof options.select === 'object')
                    ? Object.fromEntries(Object.keys(options.select).filter(k => options.select[k]).map(k => [k, (row as any)[k]]))
                    : row
                return { ok: true, data: selected }
            })

            return { resultsByIndex, transactionApplied: false }
        })

        const orm: any = {
            bulkCreate,
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
                            options: { select: { title: true } },
                            items: [{ value: { title: 'client' } }, { value: { title: 'client2' } }]
                        }
                    }
                ]
            })
        })

        const res = await handlers.ops(req)
        expect(res.status).toBe(200)
        const json = await res.json()

        const results = json.data.results[0].data.results
        expect(Array.isArray(results)).toBe(true)
        expect(results).toHaveLength(2)
        expect(results[0].ok, JSON.stringify(results[0])).toBe(true)
        expect(results[0].entityId).toBe('s1')
        expect(results[0].version).toBe(1)
        expect(results[0].data).toBeTruthy()
        expect(results[0].data.id).toBe('s1')
        expect(results[1].ok, JSON.stringify(results[1])).toBe(true)
        expect(results[1].entityId).toBe('s2')
        expect(results[1].version).toBe(1)
        expect(results[1].data).toBeTruthy()
        expect(results[1].data.id).toBe('s2')
        expect(seenOptions?.returning).toBe(true)
        expect(seenOptions?.select?.id).toBe(true)
        expect(seenOptions?.select?.version).toBe(true)
        expect(bulkCreate).toHaveBeenCalledTimes(1)
    })

    it('single update: returns data even when request returning=false, and forces select.version', async () => {
        let seenOptions: any = null

        const update = vi.fn(async (_resource: string, item: any, options: any) => {
            seenOptions = options

            const row = { id: item.id, title: 'server', version: 2 }
            const selected = (options?.select && typeof options.select === 'object')
                ? Object.fromEntries(Object.keys(options.select).filter(k => options.select[k]).map(k => [k, (row as any)[k]]))
                : row

            return { data: selected }
        })

        const orm: any = {
            update,
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
                            action: 'update',
                            options: { returning: false, select: { title: true } },
                            items: [
                                {
                                    entityId: 'p1',
                                    baseVersion: 1,
                                    value: { id: 'p1', title: 'client', version: 1 }
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
        expect(itemRes.ok, JSON.stringify(itemRes)).toBe(true)
        expect(itemRes.entityId).toBe('p1')
        expect(itemRes.version).toBe(2)
        expect(itemRes.data).toBeTruthy()
        expect(seenOptions?.returning).toBe(true)
        expect(seenOptions?.select?.version).toBe(true)
        expect(update).toHaveBeenCalledTimes(1)
    })
})
