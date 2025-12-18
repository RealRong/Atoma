import { describe, it, expect, vi } from 'vitest'
import { createAtomaServer } from '../../src/server'
import type { IOrmAdapter, QueryResult } from '../../src/server'
import { createError } from '../../src/server'
import { createNoopSyncAdapter } from './noopSyncAdapter'

const makeRestIncoming = (args: { method: string; url: string; body?: any }) => ({
    method: args.method,
    url: args.url,
    json: async () => args.body
})

describe('createAtomaServer（REST 输出 {data,pageInfo}）', () => {
    it('GET /resource 返回 {data,pageInfo}', async () => {
        const adapter: IOrmAdapter = {
            findMany: vi.fn(async () => ({ data: [{ id: 1 }], pageInfo: { hasNext: true } } satisfies QueryResult))
        }
        const handler = createAtomaServer({ adapter: { orm: adapter, sync: createNoopSyncAdapter() }, sync: { enabled: false } })

        const res = await handler(makeRestIncoming({
            method: 'GET',
            url: 'http://localhost/post?limit=2&offset=0&orderBy=createdAt:desc&where[authorId]=1'
        }))

        expect(res.status).toBe(200)
        expect(res.body).toMatchObject({
            data: [{ id: 1 }],
            pageInfo: { hasNext: true }
        })
        expect(adapter.findMany).toHaveBeenCalledWith('post', expect.objectContaining({
            where: { authorId: 1 }
        }))
    })

    it('GET /resource 支持 fields，并映射为 params.select', async () => {
        const adapter: IOrmAdapter = {
            findMany: vi.fn(async () => ({ data: [{ id: 1, title: 'hi', body: 'x' }] } satisfies QueryResult))
        }
        const handler = createAtomaServer({ adapter: { orm: adapter, sync: createNoopSyncAdapter() }, sync: { enabled: false } })

        const res = await handler(makeRestIncoming({
            method: 'GET',
            url: 'http://localhost/post?fields=id,title'
        }))

        expect(res.status).toBe(200)
        expect(adapter.findMany).toHaveBeenCalledWith('post', expect.objectContaining({
            select: { id: true, title: true }
        }))
    })

    it('GET /resource/:id 命中返回 {data:item}', async () => {
        const adapter: IOrmAdapter = {
            findMany: vi.fn(async () => ({ data: [{ id: 1, title: 'hi' }] } satisfies QueryResult))
        }
        const handler = createAtomaServer({ adapter: { orm: adapter, sync: createNoopSyncAdapter() }, sync: { enabled: false } })

        const res = await handler(makeRestIncoming({
            method: 'GET',
            url: 'http://localhost/post/1'
        }))

        expect(res.status).toBe(200)
        expect(res.body).toMatchObject({ data: { id: 1, title: 'hi' } })
    })

    it('GET /resource/:id 未命中返回 404', async () => {
        const adapter: IOrmAdapter = {
            findMany: vi.fn(async () => ({ data: [] } satisfies QueryResult))
        }
        const handler = createAtomaServer({ adapter: { orm: adapter, sync: createNoopSyncAdapter() }, sync: { enabled: false } })

        const res = await handler(makeRestIncoming({
            method: 'GET',
            url: 'http://localhost/post/999'
        }))

        expect(res.status).toBe(404)
        expect(res.body.error.code).toBe('NOT_FOUND')
    })

    it('POST /resource create 返回 201 + {data:item}', async () => {
        const adapter: IOrmAdapter = {
            findMany: vi.fn(),
            create: vi.fn(async () => ({ data: { id: 1, title: 'hi', version: 1 } }))
        }
        const handler = createAtomaServer({ adapter: { orm: adapter, sync: createNoopSyncAdapter() }, sync: { enabled: false } })

        const res = await handler(makeRestIncoming({
            method: 'POST',
            url: 'http://localhost/post',
            body: { title: 'hi' }
        }))

        expect(res.status).toBe(201)
        expect(res.body).toMatchObject({ data: { id: 1, title: 'hi' } })
    })

    it('PUT /resource/:id 映射为 bulkPatch（replace root）并返回 200 + {data:item}', async () => {
        const adapter: IOrmAdapter = {
            findMany: vi.fn(),
            patch: vi.fn(async () => ({ data: { id: 1, title: 'x', version: 1 } }))
        }
        const handler = createAtomaServer({ adapter: { orm: adapter, sync: createNoopSyncAdapter() }, sync: { enabled: false } })

        const res = await handler(makeRestIncoming({
            method: 'PUT',
            url: 'http://localhost/post/1',
            body: { title: 'x', baseVersion: 0 }
        }))

        expect(res.status).toBe(200)
        expect(adapter.patch).toHaveBeenCalledWith('post', {
            id: 1,
            patches: [{ op: 'replace', path: [1], value: { title: 'x', id: 1 } }],
            baseVersion: 0,
            timestamp: undefined
        }, expect.anything())
        expect(res.body).toMatchObject({ data: { id: 1, title: 'x' } })
    })

    it('PATCH /resource/:id（patches）映射为 bulkPatch 并返回 200 + {data:item}', async () => {
        const adapter: IOrmAdapter = {
            findMany: vi.fn(),
            patch: vi.fn(async () => ({ data: { id: 1, title: 'y', version: 1 } }))
        }
        const handler = createAtomaServer({ adapter: { orm: adapter, sync: createNoopSyncAdapter() }, sync: { enabled: false } })

        const res = await handler(makeRestIncoming({
            method: 'PATCH',
            url: 'http://localhost/post/1',
            body: { patches: [{ op: 'replace', path: ['title'], value: 'y' }], baseVersion: 0 }
        }))

        expect(res.status).toBe(200)
        expect(adapter.patch).toHaveBeenCalledWith('post', {
            id: 1,
            patches: [{ op: 'replace', path: ['title'], value: 'y' }],
            baseVersion: 0,
            timestamp: undefined
        }, expect.anything())
        expect(res.body).toMatchObject({ data: { id: 1, title: 'y' } })
    })

    it('DELETE /resource/:id 映射为 bulkDelete 并返回 204', async () => {
        const adapter: IOrmAdapter = {
            findMany: vi.fn(),
            delete: vi.fn(async () => ({ data: undefined }))
        }
        const handler = createAtomaServer({ adapter: { orm: adapter, sync: createNoopSyncAdapter() }, sync: { enabled: false } })

        const res = await handler(makeRestIncoming({
            method: 'DELETE',
            url: 'http://localhost/post/1'
            ,
            body: { baseVersion: 0 }
        }))

        expect(res.status).toBe(204)
        expect(adapter.delete).toHaveBeenCalledWith('post', { id: 1, baseVersion: 0 }, expect.anything())
    })

    it('DELETE /resource/:id 若 bulkDelete partialFailures[0] 失败则返回对应错误码', async () => {
        const adapter: IOrmAdapter = {
            findMany: vi.fn(),
            delete: vi.fn(async () => {
                throw createError('INVALID_WRITE', 'bad', { kind: 'validation' })
            })
        }
        const handler = createAtomaServer({ adapter: { orm: adapter, sync: createNoopSyncAdapter() }, sync: { enabled: false } })

        const res = await handler(makeRestIncoming({
            method: 'DELETE',
            url: 'http://localhost/post/1'
            ,
            body: { baseVersion: 0 }
        }))

        expect(res.status).toBe(422)
        expect(res.body.error.code).toBe('INVALID_WRITE')
    })

    it('未知 where op 返回 422 INVALID_QUERY', async () => {
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
    })

    it('contains 必须是 string，否则 422 INVALID_QUERY', async () => {
        const adapter: IOrmAdapter = {
            findMany: vi.fn(async () => ({ data: [] } satisfies QueryResult))
        }
        const handler = createAtomaServer({ adapter: { orm: adapter, sync: createNoopSyncAdapter() }, sync: { enabled: false } })

        const res = await handler(makeRestIncoming({
            method: 'GET',
            url: 'http://localhost/post?where[title][contains]=1'
        }))

        expect(res.status).toBe(422)
        expect(res.body.error.code).toBe('INVALID_QUERY')
    })
})
