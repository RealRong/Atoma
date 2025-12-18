import { describe, it, expect, vi } from 'vitest'
import { createAtomaServer } from '../../src/server'
import type { IOrmAdapter, QueryResult } from '../../src/server'
import { createNoopSyncAdapter } from './noopSyncAdapter'

const makeBatchIncoming = (body: any) => ({
    method: 'POST',
    url: 'http://localhost/batch',
    json: async () => body
})

const makeRestIncoming = (args: { method: string; url: string; body?: any }) => ({
    method: args.method,
    url: args.url,
    json: async () => args.body
})

describe('StandardError.details（最终规范）', () => {
    it('field_policy：包含 kind/resource/part/field/queryIndex/opId', async () => {
        const adapter: IOrmAdapter = {
            findMany: vi.fn(async () => ({ data: [] } satisfies QueryResult))
        }
        const handler = createAtomaServer({
            adapter: { orm: adapter, sync: createNoopSyncAdapter() },
            sync: { enabled: false },
            authz: { fieldPolicy: { where: { deny: ['passwordHash'] } } }
        })

        const res = await handler(makeBatchIncoming({
            ops: [{
                opId: 'r1',
                action: 'query',
                query: {
                    resource: 'post',
                    params: {
                        where: { passwordHash: 'x' },
                        page: { mode: 'offset', limit: 50, includeTotal: true }
                    }
                }
            }]
        }))

        expect(res.status).toBe(422)
        expect(res.body.error.code).toBe('INVALID_QUERY')
        expect(res.body.error.details).toMatchObject({
            kind: 'field_policy',
            resource: 'post',
            part: 'where',
            field: 'passwordHash',
            queryIndex: 0,
            opId: 'r1'
        })
    })

    it('validation：未知 where op 返回 kind=validation + path=where.<field>.<op>', async () => {
        const adapter: IOrmAdapter = {
            findMany: vi.fn(async () => ({ data: [] } satisfies QueryResult))
        }
        const handler = createAtomaServer({ adapter: { orm: adapter, sync: createNoopSyncAdapter() }, sync: { enabled: false } })

        const res = await handler(makeRestIncoming({
            method: 'GET',
            url: 'http://localhost/post?where[age][nope]=1'
        }))

        expect(res.status).toBe(422)
        expect(res.body.error.code).toBe('INVALID_QUERY')
        expect(res.body.error.details).toMatchObject({
            kind: 'validation',
            path: 'where.age.nope'
        })
    })

    it('limits：TOO_MANY_QUERIES 返回 kind=limits + max/actual', async () => {
        const adapter: IOrmAdapter = {
            findMany: vi.fn(async () => ({ data: [] } satisfies QueryResult))
        }
        const handler = createAtomaServer({
            adapter: { orm: adapter, sync: createNoopSyncAdapter() },
            sync: { enabled: false },
            limits: { query: { maxQueries: 1 } }
        })

        const res = await handler(makeBatchIncoming({
            ops: [
                { opId: 'q1', action: 'query', query: { resource: 'post', params: { page: { mode: 'offset', limit: 1, includeTotal: true } } } },
                { opId: 'q2', action: 'query', query: { resource: 'post', params: { page: { mode: 'offset', limit: 1, includeTotal: true } } } }
            ]
        }))

        expect(res.status).toBe(422)
        expect(res.body.error.code).toBe('TOO_MANY_QUERIES')
        expect(res.body.error.details).toMatchObject({ kind: 'limits', max: 1, actual: 2 })
    })

    it('internal：未知异常不泄露原始 error（message 固定为 Internal error）', async () => {
        const adapter: IOrmAdapter = {
            findMany: vi.fn(async () => ({ data: [] } satisfies QueryResult))
        }
        const handler = createAtomaServer({
            adapter: { orm: adapter, sync: createNoopSyncAdapter() },
            sync: { enabled: false },
            authz: {
                hooks: {
                    authorize: [() => {
                        throw new Error('boom')
                    }]
                }
            }
        })

        const res = await handler(makeBatchIncoming({
            ops: [{
                opId: 'q1',
                action: 'query',
                query: { resource: 'post', params: { page: { mode: 'offset', limit: 50, includeTotal: true } } }
            }]
        }))

        expect(res.status).toBe(500)
        expect(res.body.error.code).toBe('INTERNAL')
        expect(res.body.error.message).toBe('Internal error')
        expect(res.body.error.details).toMatchObject({ kind: 'internal' })
    })
})
