import { describe, it, expect, vi } from 'vitest'
import { BatchDispatcher } from '../../src/batch/BatchDispatcher'

const createFetch = (responseBody: any) => {
    const json = vi.fn(async () => responseBody)
    const fetchFn = vi.fn(async () => ({
        ok: true,
        json
    }))
    return { fetchFn, json }
}

describe('BatchDispatcher write batching', () => {
    it('合并多次 create 为一条 bulkCreate', async () => {
        const { fetchFn } = createFetch({ results: [{ data: [] }] })
        const dispatcher = new BatchDispatcher({ fetchFn, endpoint: '/batch' })

        await Promise.all([
            dispatcher.enqueueCreate('post', { id: 1, data: { title: 'a' } }, async () => { }),
            dispatcher.enqueueCreate('post', { id: 2, data: { title: 'b' } }, async () => { })
        ])

        expect(fetchFn).toHaveBeenCalledTimes(1)
        const body = JSON.parse((fetchFn.mock.calls[0][1] as any).body)
        expect(body.action).toBe('bulkCreate')
        expect(body.payload).toHaveLength(2)
    })

    it('合并多次 put 为一条 bulkUpdate', async () => {
        const { fetchFn } = createFetch({ results: [{ data: [] }] })
        const dispatcher = new BatchDispatcher({ fetchFn, endpoint: '/batch' })

        await Promise.all([
            dispatcher.enqueueUpdate('post', { id: 1, data: { title: 'a' } }, async () => { }),
            dispatcher.enqueueUpdate('post', { id: 2, data: { title: 'b' } }, async () => { })
        ])

        expect(fetchFn).toHaveBeenCalledTimes(1)
        const body = JSON.parse((fetchFn.mock.calls[0][1] as any).body)
        expect(body.action).toBe('bulkUpdate')
        expect(body.payload).toHaveLength(2)
    })

    it('超过 maxBatchSize 会被切片多次发送', async () => {
        const { fetchFn } = createFetch({ results: [{ data: [] }] })
        const dispatcher = new BatchDispatcher({ fetchFn, endpoint: '/batch', maxBatchSize: 1 })

        await Promise.all([
            dispatcher.enqueueUpdate('post', { id: 1, data: { title: 'a' } }, async () => { }),
            dispatcher.enqueueUpdate('post', { id: 2, data: { title: 'b' } }, async () => { })
        ])

        expect(fetchFn).toHaveBeenCalledTimes(2)
    })

    it('partialFailures 会精确 reject 对应项', async () => {
        const { fetchFn } = createFetch({
            results: [{
                data: [],
                partialFailures: [{ index: 1, error: { code: 'FAIL' } }]
            }]
        })
        const dispatcher = new BatchDispatcher({ fetchFn, endpoint: '/batch' })

        const first = dispatcher.enqueueUpdate('post', { id: 1, data: { title: 'ok' } }, async () => { })
        const second = dispatcher.enqueueUpdate('post', { id: 2, data: { title: 'bad' } }, async () => { })

        await expect(first).resolves.toBeUndefined()
        await expect(second).rejects.toMatchObject({ code: 'FAIL' })
    })

    it('create partialFailures 只拒绝对应项', async () => {
        const { fetchFn } = createFetch({
            results: [{
                data: [],
                partialFailures: [{ index: 0, error: { code: 'FAIL_CREATE' } }]
            }]
        })
        const dispatcher = new BatchDispatcher({ fetchFn, endpoint: '/batch' })

        const first = dispatcher.enqueueCreate('post', { id: 1, data: { title: 'bad' } }, async () => { })
        const second = dispatcher.enqueueCreate('post', { id: 2, data: { title: 'ok' } }, async () => { })

        await expect(first).rejects.toMatchObject({ code: 'FAIL_CREATE' })
        await expect(second).resolves.toBeUndefined()
    })
})
