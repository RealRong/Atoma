import { describe, it, expect, vi } from 'vitest'
import { createHandler } from '../../src/server'
import type { IOrmAdapter, QueryResult } from '../../src/server'
import { createError } from '../../src/server'

const makeRestIncoming = (args: { method: string; url: string; body?: any }) => ({
    method: args.method,
    url: args.url,
    json: async () => args.body
})

describe('createHandler（REST 输出 {data,pageInfo}）', () => {
    it('GET /resource 返回 {data,pageInfo}', async () => {
        const adapter: IOrmAdapter = {
            findMany: vi.fn(async () => ({ data: [{ id: 1 }], pageInfo: { hasNext: true } } satisfies QueryResult)),
            isResourceAllowed: vi.fn(() => true)
        }
        const handler = createHandler({ adapter })

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
            findMany: vi.fn(async () => ({ data: [{ id: 1, title: 'hi', body: 'x' }] } satisfies QueryResult)),
            isResourceAllowed: vi.fn(() => true)
        }
        const handler = createHandler({ adapter })

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
            findMany: vi.fn(async () => ({ data: [{ id: 1, title: 'hi' }] } satisfies QueryResult)),
            isResourceAllowed: vi.fn(() => true)
        }
        const handler = createHandler({ adapter })

        const res = await handler(makeRestIncoming({
            method: 'GET',
            url: 'http://localhost/post/1'
        }))

        expect(res.status).toBe(200)
        expect(res.body).toMatchObject({ data: { id: 1, title: 'hi' } })
    })

    it('GET /resource/:id 未命中返回 404', async () => {
        const adapter: IOrmAdapter = {
            findMany: vi.fn(async () => ({ data: [] } satisfies QueryResult)),
            isResourceAllowed: vi.fn(() => true)
        }
        const handler = createHandler({ adapter })

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
            isResourceAllowed: vi.fn(() => true),
            bulkCreate: vi.fn(async () => ({ data: [{ id: 1, title: 'hi' }] }))
        }
        const handler = createHandler({ adapter })

        const res = await handler(makeRestIncoming({
            method: 'POST',
            url: 'http://localhost/post',
            body: { title: 'hi' }
        }))

        expect(res.status).toBe(201)
        expect(res.body).toMatchObject({ data: { id: 1, title: 'hi' } })
    })

    it('PUT /resource/:id 映射为 bulkUpdate（payload 长度=1）并返回 200 + {data:item}', async () => {
        const adapter: IOrmAdapter = {
            findMany: vi.fn(),
            isResourceAllowed: vi.fn(() => true),
            bulkUpdate: vi.fn(async () => ({ data: [{ id: 1, title: 'x' }] }))
        }
        const handler = createHandler({ adapter })

        const res = await handler(makeRestIncoming({
            method: 'PUT',
            url: 'http://localhost/post/1',
            body: { title: 'x' }
        }))

        expect(res.status).toBe(200)
        expect(adapter.bulkUpdate).toHaveBeenCalledWith('post', [{ id: 1, data: { title: 'x' } }], undefined)
        expect(res.body).toMatchObject({ data: { id: 1, title: 'x' } })
    })

    it('PATCH /resource/:id（patches）映射为 bulkPatch 并返回 200 + {data:item}', async () => {
        const adapter: IOrmAdapter = {
            findMany: vi.fn(),
            isResourceAllowed: vi.fn(() => true),
            bulkPatch: vi.fn(async () => ({ data: [{ id: 1, title: 'y' }] }))
        }
        const handler = createHandler({ adapter })

        const res = await handler(makeRestIncoming({
            method: 'PATCH',
            url: 'http://localhost/post/1',
            body: { patches: [{ op: 'replace', path: ['title'], value: 'y' }] }
        }))

        expect(res.status).toBe(200)
        expect(adapter.bulkPatch).toHaveBeenCalledWith('post', [{
            id: 1,
            patches: [{ op: 'replace', path: ['title'], value: 'y' }],
            baseVersion: undefined,
            timestamp: undefined
        }], undefined)
        expect(res.body).toMatchObject({ data: { id: 1, title: 'y' } })
    })

    it('DELETE /resource/:id 映射为 bulkDelete 并返回 204', async () => {
        const adapter: IOrmAdapter = {
            findMany: vi.fn(),
            isResourceAllowed: vi.fn(() => true),
            bulkDelete: vi.fn(async () => ({ data: [] }))
        }
        const handler = createHandler({ adapter })

        const res = await handler(makeRestIncoming({
            method: 'DELETE',
            url: 'http://localhost/post/1'
        }))

        expect(res.status).toBe(204)
        expect(adapter.bulkDelete).toHaveBeenCalledWith('post', [1], undefined)
    })

    it('DELETE /resource/:id 若 bulkDelete partialFailures[0] 失败则返回对应错误码', async () => {
        const adapter: IOrmAdapter = {
            findMany: vi.fn(),
            isResourceAllowed: vi.fn(() => true),
            bulkDelete: vi.fn(async () => ({
                data: [],
                partialFailures: [{ index: 0, error: createError('INVALID_WRITE', 'bad', { kind: 'validation' }) }]
            }))
        }
        const handler = createHandler({ adapter })

        const res = await handler(makeRestIncoming({
            method: 'DELETE',
            url: 'http://localhost/post/1'
        }))

        expect(res.status).toBe(422)
        expect(res.body.error.code).toBe('INVALID_WRITE')
    })

    it('未知 where op 返回 422 INVALID_QUERY', async () => {
        const adapter: IOrmAdapter = {
            findMany: vi.fn(async () => ({ data: [] } satisfies QueryResult)),
            isResourceAllowed: vi.fn(() => true)
        }
        const handler = createHandler({ adapter })

        const res = await handler(makeRestIncoming({
            method: 'GET',
            url: 'http://localhost/post?where[age][nope]=1'
        }))

        expect(res.status).toBe(422)
        expect(res.body.error.code).toBe('INVALID_QUERY')
    })

    it('contains 必须是 string，否则 422 INVALID_QUERY', async () => {
        const adapter: IOrmAdapter = {
            findMany: vi.fn(async () => ({ data: [] } satisfies QueryResult)),
            isResourceAllowed: vi.fn(() => true)
        }
        const handler = createHandler({ adapter })

        const res = await handler(makeRestIncoming({
            method: 'GET',
            url: 'http://localhost/post?where[title][contains]=1'
        }))

        expect(res.status).toBe(422)
        expect(res.body.error.code).toBe('INVALID_QUERY')
    })
})
