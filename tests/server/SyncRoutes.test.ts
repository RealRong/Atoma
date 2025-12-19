import { describe, it, expect } from 'vitest'
import { createAtomaServer, throwError } from '../../src/server'
import type { IOrmAdapter } from '../../src/server'
import type { ISyncAdapter, AtomaChange, IdempotencyResult } from '../../src/server'

type Row = Record<string, any>

function createMemoryOrm(): IOrmAdapter {
    const tables = new Map<string, Map<string, Row>>()
    const table = (resource: string) => {
        const t = tables.get(resource) ?? new Map<string, Row>()
        if (!tables.has(resource)) tables.set(resource, t)
        return t
    }

    const findMany: IOrmAdapter['findMany'] = async (resource, params) => {
        const t = table(resource)
        const whereId = (params.where as any)?.id
        const rows = whereId !== undefined
            ? (t.has(String(whereId)) ? [t.get(String(whereId))] : [])
            : Array.from(t.values())

        const select = params.select
        const projected = select
            ? rows.map(r => {
                const out: any = {}
                Object.keys(select).forEach(k => {
                    if ((select as any)[k]) out[k] = (r as any)[k]
                })
                return out
            })
            : rows

        return { data: projected as any[] }
    }

    const bulkCreate: IOrmAdapter['bulkCreate'] = async (resource, items) => {
        const t = table(resource)
        const saved: any[] = []
        for (const item of items) {
            const id = item.id ?? `${t.size + 1}`
            const row = { ...item, id }
            t.set(String(id), row)
            saved.push(row)
        }
        return { data: saved }
    }

    const patch: IOrmAdapter['patch'] = async (resource, item) => {
        const t = table(resource)
        const current = t.get(String(item.id))
        if (!current) throw new Error('Not found')
        const currentVersion = current.version
        if (typeof item.baseVersion === 'number' && currentVersion !== item.baseVersion) {
            throwError('CONFLICT', 'Version conflict', {
                kind: 'conflict',
                resource,
                currentVersion,
                currentValue: current
            })
        }
        const next = { ...current }
        for (const p of item.patches as any[]) {
            if (p.op === 'replace' && Array.isArray(p.path) && typeof p.path[0] === 'string') {
                next[p.path[0]] = p.value
            }
        }
        next.version = (typeof next.version === 'number' ? next.version : 0) + 1
        t.set(String(item.id), next)
        return { data: next }
    }

    const del: IOrmAdapter['delete'] = async (resource, whereOrId) => {
        const t = table(resource)
        const id = typeof whereOrId === 'object' ? (whereOrId as any).id : whereOrId
        const current = t.get(String(id))
        if (!current) throw new Error('Not found')
        const baseVersion = typeof whereOrId === 'object' ? (whereOrId as any).baseVersion : undefined
        if (typeof baseVersion === 'number' && current.version !== baseVersion) {
            throwError('CONFLICT', 'Version conflict', {
                kind: 'conflict',
                resource,
                currentVersion: current.version,
                currentValue: current
            })
        }
        t.delete(String(id))
        return { data: undefined }
    }

    const orm: any = {
        findMany,
        bulkCreate,
        patch,
        delete: del
    }

    orm.transaction = async <T>(fn: any) => fn({ orm, tx: undefined })

    return orm as IOrmAdapter
}

function createMemorySync(): ISyncAdapter & { changes: AtomaChange[] } {
    const idempotency = new Map<string, { status: number; body: unknown; expiresAt: number }>()
    const changes: AtomaChange[] = []
    let cursor = 0

    const getIdempotency = async (key: string, _tx?: unknown): Promise<IdempotencyResult> => {
        const hit = idempotency.get(key)
        if (!hit) return { hit: false }
        if (hit.expiresAt > 0 && Date.now() > hit.expiresAt) return { hit: false }
        return { hit: true, status: hit.status, body: hit.body }
    }

    const putIdempotency = async (key: string, value: { status: number; body: unknown }, ttlMs?: number, _tx?: unknown) => {
        const expiresAt = Date.now() + Math.max(0, Math.floor(ttlMs ?? 0))
        if (!idempotency.has(key)) {
            idempotency.set(key, { status: value.status, body: value.body, expiresAt })
        }
    }

    const appendChange = async (change: Omit<AtomaChange, 'cursor'>, _tx?: unknown) => {
        cursor += 1
        const row = { ...change, cursor }
        changes.push(row)
        return row
    }

    const pullChanges = async (from: number, limit: number) => {
        return changes.filter(c => c.cursor > from).slice(0, limit)
    }

    const waitForChanges = async (from: number, timeoutMs: number) => {
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
            const next = await pullChanges(from, 200)
            if (next.length) return next
            await new Promise(r => setTimeout(r, 10))
        }
        return []
    }

    return { getIdempotency, putIdempotency, appendChange, pullChanges, waitForChanges, changes }
}

describe('/sync/*', () => {
    it('POST /sync/push：acked + rejected + 幂等去重', async () => {
        const orm = createMemoryOrm()
        const sync = createMemorySync()

        // seed
        await orm.bulkCreate?.('post', [{ id: 1, title: 'a', version: 0 }])

        const handler = createAtomaServer({
            adapter: {
                orm,
                sync
            },
            authz: { resources: { allow: ['post'] } }
        })

        const res1 = await handler({
            method: 'POST',
            url: 'http://localhost/sync/push',
            json: async () => ({
                ops: [
                    {
                        idempotencyKey: 'k1',
                        resource: 'post',
                        kind: 'patch',
                        id: 1,
                        baseVersion: 0,
                        patches: [{ op: 'replace', path: ['title'], value: 'b' }]
                    },
                    {
                        idempotencyKey: 'k2',
                        resource: 'post',
                        kind: 'delete',
                        id: 1,
                        baseVersion: 999
                    }
                ]
            })
        })

        expect(res1.status).toBe(200)
        expect(res1.body.acked).toHaveLength(1)
        expect(res1.body.rejected).toHaveLength(1)
        expect(res1.body.acked[0]).toMatchObject({ idempotencyKey: 'k1', resource: 'post', id: '1', serverVersion: 1 })
        expect(res1.body.rejected[0].idempotencyKey).toBe('k2')
        expect(res1.body.rejected[0].error.code).toBe('CONFLICT')
        expect(res1.body.rejected[0].currentVersion).toBe(1)

        const changeCount1 = sync.changes.length

        const res2 = await handler({
            method: 'POST',
            url: 'http://localhost/sync/push',
            json: async () => ({
                ops: [
                    {
                        idempotencyKey: 'k1',
                        resource: 'post',
                        kind: 'patch',
                        id: 1,
                        baseVersion: 0,
                        patches: [{ op: 'replace', path: ['title'], value: 'b' }]
                    }
                ]
            })
        })

        expect(res2.status).toBe(200)
        expect(res2.body.acked).toHaveLength(1)
        expect(sync.changes.length).toBe(changeCount1)
    })

    it('GET /sync/pull：返回 changes 摘要且推进 nextCursor', async () => {
        const orm = createMemoryOrm()
        const sync = createMemorySync()
        await sync.appendChange({ resource: 'post', id: '1', kind: 'upsert', serverVersion: 1, changedAt: 1 })
        await sync.appendChange({ resource: 'post', id: '2', kind: 'delete', serverVersion: 2, changedAt: 2 })

        const handler = createAtomaServer({
            adapter: {
                orm,
                sync
            },
            authz: { resources: { allow: ['post'] } }
        })

        const res = await handler({ method: 'GET', url: 'http://localhost/sync/pull?cursor=0&limit=1' })
        expect(res.status).toBe(200)
        expect(res.body.changes).toHaveLength(1)
        expect(res.body.nextCursor).toBe(1)
        expect(res.body.changes[0]).toMatchObject({ resource: 'post', id: '1', kind: 'upsert', serverVersion: 1 })
    })

    it('GET /sync/pull：authorize 拒绝的资源不会下发 changes（但 nextCursor 仍推进）', async () => {
        const orm = createMemoryOrm()
        const sync = createMemorySync()
        await sync.appendChange({ resource: 'post', id: '1', kind: 'upsert', serverVersion: 1, changedAt: 1 })
        await sync.appendChange({ resource: 'comment', id: '9', kind: 'upsert', serverVersion: 1, changedAt: 2 })

        const handler = createAtomaServer({
            adapter: { orm, sync },
            authz: {
                resources: { allow: ['post', 'comment'] },
                hooks: {
                    authorize: [async (args: any) => {
                        if (args.action === 'sync' && args.resource === 'post') {
                            throwError('ACCESS_DENIED', 'no', { kind: 'access', resource: 'post' })
                        }
                    }]
                }
            }
        })

        const res = await handler({ method: 'GET', url: 'http://localhost/sync/pull?cursor=0&limit=50' })
        expect(res.status).toBe(200)
        expect(res.body.nextCursor).toBe(2)
        expect(res.body.changes).toHaveLength(1)
        expect(res.body.changes[0].resource).toBe('comment')
    })

    it('GET /sync/subscribe：authorize 拒绝的资源不会下发 changes', async () => {
        const orm = createMemoryOrm()
        const sync = createMemorySync()
        const handler = createAtomaServer({
            adapter: { orm, sync },
            authz: {
                resources: { allow: ['post', 'comment'] },
                hooks: {
                    authorize: [async (args: any) => {
                        if (args.action === 'sync' && args.resource === 'post') {
                            throwError('ACCESS_DENIED', 'no', { kind: 'access', resource: 'post' })
                        }
                    }]
                }
            },
            sync: { subscribe: { maxHoldMs: 50, heartbeatMs: 5, retryMs: 10 } }
        })

        const controller = new AbortController()
        const res = await handler({
            method: 'GET',
            url: 'http://localhost/sync/subscribe?cursor=0',
            signal: controller.signal
        })

        // emit 2 changes
        void sync.appendChange({ resource: 'post', id: '1', kind: 'upsert', serverVersion: 1, changedAt: Date.now() })
        void sync.appendChange({ resource: 'comment', id: '9', kind: 'upsert', serverVersion: 1, changedAt: Date.now() })

        let got = ''
        // @ts-ignore
        for await (const chunk of res.body as AsyncIterable<string>) {
            got += chunk
            if (got.includes('event: changes') && got.includes('data:')) {
                controller.abort()
                break
            }
        }

        const m = got.match(/event: changes\n[\s\S]*?data: (.+)\n\n/)
        expect(m).toBeTruthy()
        const evt = JSON.parse(m![1])
        expect(Array.isArray(evt.changes)).toBe(true)
        expect(evt.changes.every((c: any) => c.resource === 'comment')).toBe(true)
    })

    it('POST /batch bulkPatch：写入 changes + 幂等去重', async () => {
        const orm = createMemoryOrm()
        const sync = createMemorySync()

        await orm.bulkCreate?.('post', [{ id: 1, title: 'a', version: 0 }])

        const handler = createAtomaServer({
            adapter: { orm, sync },
            authz: { resources: { allow: ['post'] } }
        })

        const res1 = await handler({
            method: 'POST',
            url: 'http://localhost/batch',
            json: async () => ({
                ops: [{
                    opId: 'w1',
                    action: 'bulkPatch',
                    resource: 'post',
                    payload: [{
                        id: 1,
                        baseVersion: 0,
                        meta: { idempotencyKey: 'b1' },
                        patches: [{ op: 'replace', path: ['title'], value: 'b' }]
                    }]
                }]
            })
        })

        expect(res1.status).toBe(200)
        expect(res1.body.results[0].ok).toBe(true)
        expect(res1.body.results[0].data[0]).toMatchObject({ id: 1, title: 'b', version: 1 })
        expect(sync.changes).toHaveLength(1)

        const res2 = await handler({
            method: 'POST',
            url: 'http://localhost/batch',
            json: async () => ({
                ops: [{
                    opId: 'w1',
                    action: 'bulkPatch',
                    resource: 'post',
                    payload: [{
                        id: 1,
                        baseVersion: 0,
                        meta: { idempotencyKey: 'b1' },
                        patches: [{ op: 'replace', path: ['title'], value: 'b' }]
                    }]
                }]
            })
        })

        expect(res2.status).toBe(200)
        expect(sync.changes).toHaveLength(1)

        const pulled = await handler({
            method: 'GET',
            url: 'http://localhost/sync/pull?cursor=0&limit=50'
        })

        expect(pulled.status).toBe(200)
        expect(pulled.body.changes).toHaveLength(1)
        expect(pulled.body.changes[0]).toMatchObject({
            resource: 'post',
            id: '1',
            kind: 'upsert',
            serverVersion: 1
        })
    })

    it('REST PATCH /resource/:id：同样写入 changes', async () => {
        const orm = createMemoryOrm()
        const sync = createMemorySync()

        await orm.bulkCreate?.('post', [{ id: 1, title: 'a', version: 0 }])

        const handler = createAtomaServer({
            adapter: { orm, sync },
            authz: { resources: { allow: ['post'] } }
        })

        const res = await handler({
            method: 'PATCH',
            url: 'http://localhost/post/1',
            json: async () => ({
                baseVersion: 0,
                patches: [{ op: 'replace', path: ['title'], value: 'z' }]
            })
        })

        expect(res.status).toBe(200)

        const pulled = await handler({
            method: 'GET',
            url: 'http://localhost/sync/pull?cursor=0&limit=50'
        })

        expect(pulled.status).toBe(200)
        expect(pulled.body.changes).toHaveLength(1)
        expect(pulled.body.changes[0]).toMatchObject({
            resource: 'post',
            id: '1',
            kind: 'upsert',
            serverVersion: 1
        })
    })

    it('GET /sync/subscribe：SSE 输出 event: changes', async () => {
        const orm = createMemoryOrm()
        const sync = createMemorySync()
        const handler = createAtomaServer({
            adapter: {
                orm,
                sync
            },
            authz: { resources: { allow: ['post'] } },
            sync: { subscribe: { maxHoldMs: 50, heartbeatMs: 5, retryMs: 10 } }
        })

        const controller = new AbortController()
        const res = await handler({
            method: 'GET',
            url: 'http://localhost/sync/subscribe?cursor=0',
            signal: controller.signal
        })

        expect(res.status).toBe(200)
        expect(res.headers?.['content-type']).toContain('text/event-stream')

        // emit one change then ensure stream outputs it
        void sync.appendChange({ resource: 'post', id: '1', kind: 'upsert', serverVersion: 1, changedAt: Date.now() })

        let got = ''
        // @ts-ignore
        for await (const chunk of res.body as AsyncIterable<string>) {
            got += chunk
            if (got.includes('event: changes') && got.includes('data:')) {
                controller.abort()
                break
            }
        }
        expect(got).toContain('event: changes')
        expect(got).toContain('data:')
    })
})
