import { describe, it, expect, vi } from 'vitest'
import { BatchEngine } from '../../src/batch/BatchEngine'

const waitFor = async (predicate: () => boolean, maxTicks: number = 50) => {
    for (let i = 0; i < maxTicks; i++) {
        if (predicate()) return
        await Promise.resolve()
    }
    throw new Error('waitFor timeout')
}

describe('BatchEngine dispose（abort + 全部 reject）', () => {
    it('dispose 会 abort in-flight query 并 reject（不走 fallback）', async () => {
        let aborted = false
        const fetchFn = vi.fn(async (_url: any, init: any) => {
            const signal: AbortSignal | undefined = init?.signal
            return await new Promise((_resolve, reject) => {
                if (!signal) {
                    reject(new Error('Missing signal'))
                    return
                }
                if (signal.aborted) {
                    aborted = true
                    const err = Object.assign(new Error('AbortError'), { name: 'AbortError' })
                    reject(err)
                    return
                }
                signal.addEventListener('abort', () => {
                    aborted = true
                    const err = Object.assign(new Error('AbortError'), { name: 'AbortError' })
                    reject(err)
                })
            })
        })

        const fallback = vi.fn(async () => [])
        const engine = new BatchEngine({ fetchFn, endpoint: '/batch' })

        const p = engine.enqueueQuery('post', { limit: 1, offset: 0 }, fallback)
        await waitFor(() => fetchFn.mock.calls.length === 1)

        engine.dispose()

        await expect(p).rejects.toThrow('BatchEngine disposed')
        expect(aborted).toBe(true)
        expect(fallback).not.toHaveBeenCalled()
    })

    it('dispose 会 abort in-flight write 并 reject', async () => {
        let aborted = false
        const fetchFn = vi.fn(async (_url: any, init: any) => {
            const signal: AbortSignal | undefined = init?.signal
            return await new Promise((_resolve, reject) => {
                if (!signal) {
                    reject(new Error('Missing signal'))
                    return
                }
                signal.addEventListener('abort', () => {
                    aborted = true
                    const err = Object.assign(new Error('AbortError'), { name: 'AbortError' })
                    reject(err)
                })
            })
        })

        const engine = new BatchEngine({ fetchFn, endpoint: '/batch' })

        const p = engine.enqueueUpdate('post', { id: 1, data: { title: 'a' }, baseVersion: 0 })
        await waitFor(() => fetchFn.mock.calls.length === 1)

        engine.dispose()

        await expect(p).rejects.toThrow('BatchEngine disposed')
        expect(aborted).toBe(true)
    })
})
