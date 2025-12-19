import { describe, it, expect, vi } from 'vitest'
import { BatchEngine } from '../../src/batch/BatchEngine'

describe('BatchEngine maxQueueLength（per-lane）', () => {
    it('query 默认 reject_new：超过上限直接 reject 新入队', async () => {
        const fetchFn = vi.fn()
        const engine = new BatchEngine({
            fetchFn: fetchFn as any,
            endpoint: '/batch',
            flushIntervalMs: 10000,
            maxQueueLength: { query: 1 }
        })

        const first = engine.enqueueQuery('post', { limit: 1, offset: 0 }, async () => [])
        const second = engine.enqueueQuery('post', { limit: 1, offset: 1 }, async () => [])

        await expect(second).rejects.toThrow('BatchEngine queue overflow')
        expect(fetchFn).toHaveBeenCalledTimes(0)

        engine.dispose()
        await expect(first).rejects.toThrow('BatchEngine disposed')
    })

    it('query drop_old_queries：丢弃最旧 query 并接受新入队', async () => {
        const fetchFn = vi.fn()
        const engine = new BatchEngine({
            fetchFn: fetchFn as any,
            endpoint: '/batch',
            flushIntervalMs: 10000,
            maxQueueLength: { query: 1 },
            queryOverflowStrategy: 'drop_old_queries'
        })

        const first = engine.enqueueQuery('post', { limit: 1, offset: 0 }, async () => [])
        const second = engine.enqueueQuery('post', { limit: 1, offset: 1 }, async () => [])

        await expect(first).rejects.toThrow('BatchEngine dropped old query due to queue overflow')
        expect(fetchFn).toHaveBeenCalledTimes(0)

        engine.dispose()
        await expect(second).rejects.toThrow('BatchEngine disposed')
    })

    it('write 只支持 reject_new：超过上限直接 reject 新入队', async () => {
        const fetchFn = vi.fn()
        const engine = new BatchEngine({
            fetchFn: fetchFn as any,
            endpoint: '/batch',
            flushIntervalMs: 10000,
            maxQueueLength: { write: 1 }
        })

        const first = engine.enqueueUpdate('post', { id: 1, data: { title: 'a' }, baseVersion: 0 })
        const second = engine.enqueueUpdate('post', { id: 2, data: { title: 'b' }, baseVersion: 0 })

        await expect(second).rejects.toThrow('BatchEngine queue overflow')
        expect(fetchFn).toHaveBeenCalledTimes(0)

        engine.dispose()
        await expect(first).rejects.toThrow('BatchEngine disposed')
    })
})
