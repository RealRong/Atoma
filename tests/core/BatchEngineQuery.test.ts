import { describe, it, expect, vi } from 'vitest'
import { BatchEngine } from '../../src/batch/BatchEngine'

describe('BatchEngine query batching（op-list 协议）', () => {
    it('query 会补齐 params.page（offset 模式）', async () => {
        const fetchFn = vi.fn(async (_url: any, init: any) => {
            const body = JSON.parse(init.body)
            return {
                ok: true,
                json: async () => ({
                    results: body.ops.map((op: any) => ({ opId: op.opId, ok: true, data: [] }))
                })
            }
        })

        const engine = new BatchEngine({ fetchFn, endpoint: '/batch' })
        await engine.enqueueQuery('post', { limit: 20, offset: 0 }, async () => [])

        expect(fetchFn).toHaveBeenCalledTimes(1)
        const body = JSON.parse((fetchFn.mock.calls[0][1] as any).body)
        expect(body.ops[0].action).toBe('query')
        expect(body.ops[0].query.params.page).toMatchObject({ mode: 'offset', limit: 20, offset: 0 })
    })

    it('query 会把 FindManyOptions.cursor 映射为 page.after（cursor 模式）', async () => {
        const fetchFn = vi.fn(async (_url: any, init: any) => {
            const body = JSON.parse(init.body)
            return {
                ok: true,
                json: async () => ({
                    results: body.ops.map((op: any) => ({ opId: op.opId, ok: true, data: [] }))
                })
            }
        })

        const engine = new BatchEngine({ fetchFn, endpoint: '/batch' })
        await engine.enqueueQuery('comment', { limit: 10, cursor: 'tok' }, async () => [])

        const body = JSON.parse((fetchFn.mock.calls[0][1] as any).body)
        expect(body.ops[0].query.params.page).toMatchObject({ mode: 'cursor', limit: 10, after: 'tok' })
        expect(body.ops[0].query.params.cursor).toBeUndefined()
    })

    it('query 在未传 options 时也会补齐默认 page', async () => {
        const fetchFn = vi.fn(async (_url: any, init: any) => {
            const body = JSON.parse(init.body)
            return {
                ok: true,
                json: async () => ({
                    results: body.ops.map((op: any) => ({ opId: op.opId, ok: true, data: [] }))
                })
            }
        })

        const engine = new BatchEngine({ fetchFn, endpoint: '/batch' })
        await engine.enqueueQuery('post', undefined, async () => [])

        const body = JSON.parse((fetchFn.mock.calls[0][1] as any).body)
        expect(body.ops[0].query.params.page).toMatchObject({ mode: 'offset', limit: 50 })
    })

    it('query 支持 fields（sparse fieldset），会映射为 params.select 并移除 fields', async () => {
        const fetchFn = vi.fn(async (_url: any, init: any) => {
            const body = JSON.parse(init.body)
            return {
                ok: true,
                json: async () => ({
                    results: body.ops.map((op: any) => ({ opId: op.opId, ok: true, data: [] }))
                })
            }
        })

        const engine = new BatchEngine({ fetchFn, endpoint: '/batch' })
        await engine.enqueueQuery('post', { fields: ['id', 'title'] } as any, async () => [])

        const body = JSON.parse((fetchFn.mock.calls[0][1] as any).body)
        expect(body.ops[0].query.params.select).toMatchObject({ id: true, title: true })
        expect(body.ops[0].query.params.fields).toBeUndefined()
    })
})
