import { describe, expect, it, vi } from 'vitest'
import { createClient } from '../../src'
import { Backend } from '#backend'

type Post = {
    id: string
    title: string
    createdAt: number
    updatedAt: number
    version?: number
}

describe('Phase 6 verification (Sync split)', () => {
    it('direct 写入语义不随 Sync.start/stop 漂移', async () => {
        const opsClient = new Backend.MemoryOpsClient()
        const executeOps = vi.spyOn(opsClient as any, 'executeOps')

        const client = createClient<{ posts: Post }>({
            schema: {
                posts: {}
            },
            store: {
                type: 'custom',
                role: 'remote',
                backend: { id: 'remote-phase6-direct', opsClient }
            },
            sync: { pullIntervalMs: 0, queue: 'intent-only' }
        })

        const posts = client.Store('posts')

        const c0 = executeOps.mock.calls.length
        await posts.addOne({ title: 'a' } as any)
        const c1 = executeOps.mock.calls.length
        expect(c1).toBeGreaterThan(c0)

        client.Sync.start('push-only')
        await posts.addOne({ title: 'b' } as any)
        const c2 = executeOps.mock.calls.length
        expect(c2).toBeGreaterThan(c1)

        client.Sync.stop()
        await posts.addOne({ title: 'c' } as any)
        const c3 = executeOps.mock.calls.length
        expect(c3).toBeGreaterThan(c2)
    })

    it('Sync.Store enqueue 阶段不触达远端 I/O；flush 才会 push', async () => {
        const opsClient = new Backend.MemoryOpsClient()
        const executeOps = vi.spyOn(opsClient as any, 'executeOps')

        const client = createClient<{ posts: Post }>({
            schema: {
                posts: {}
            },
            store: {
                type: 'custom',
                role: 'remote',
                backend: { id: 'remote-phase6-enqueue', opsClient }
            },
            sync: { pullIntervalMs: 0, queue: 'intent-only' }
        })

        client.Sync.start('push-only')

        executeOps.mockClear()
        await client.Sync.Store('posts').addOne({ title: 'x' } as any)
        expect(executeOps).toHaveBeenCalledTimes(0)

        await client.Sync.flush()
        expect(executeOps.mock.calls.length).toBeGreaterThan(0)
    })

    it('pull-only 不需要 subscribe 能力（即使 defaults.subscribe=true）', () => {
        const client = createClient<{ posts: Post }>({
            schema: {
                posts: {}
            },
            store: {
                type: 'custom',
                role: 'remote',
                backend: { id: 'remote-phase6-pull-only', opsClient: new Backend.MemoryOpsClient() }
            },
            sync: { subscribe: true, pullIntervalMs: 0 }
        })

        expect(() => client.Sync.start('pull-only')).not.toThrow()
        client.Sync.stop()
    })

    it('pull+subscribe 必须提供 subscribe 能力（sync.target）', () => {
        const client = createClient<{ posts: Post }>({
            schema: {
                posts: {}
            },
            store: {
                type: 'custom',
                role: 'remote',
                backend: { id: 'remote-phase6-pull-sub', opsClient: new Backend.MemoryOpsClient() }
            },
            sync: { subscribe: true, pullIntervalMs: 0 }
        })

        expect(() => client.Sync.start('pull+subscribe')).toThrow('subscribe')
    })

    it('intent-only 的 Sync.Store.updateOne 在 cache miss 时不会发生远端隐式补读', async () => {
        const opsClient = new Backend.MemoryOpsClient()
        const executeOps = vi.spyOn(opsClient as any, 'executeOps')

        const client = createClient<{ posts: Post }>({
            schema: {
                posts: {}
            },
            store: {
                type: 'custom',
                role: 'remote',
                backend: { id: 'remote-phase6-no-implicit', opsClient }
            },
            sync: { pullIntervalMs: 0, queue: 'intent-only' }
        })

        executeOps.mockClear()

        await expect(
            client.Sync.Store('posts').updateOne('missing', () => {
                // noop
            })
        ).rejects.toThrow('禁止补读')

        expect(executeOps).toHaveBeenCalledTimes(0)
    })

    it('local-first 的 Sync.Store.updateOne cache miss 允许本地补读（不会报“禁止补读”）', async () => {
        const client = createClient<{ posts: Post }>({
            schema: {
                posts: {}
            },
            store: {
                type: 'memory'
            },
            sync: {
                backend: {
                    id: 'remote-phase6-localfirst',
                    opsClient: new Backend.MemoryOpsClient()
                },
                pullIntervalMs: 0,
                queue: 'local-first'
            }
        })

        try {
            await client.Sync.Store('posts').updateOne('missing', () => {
                // noop
            })
            throw new Error('expected updateOne to throw')
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            expect(message).not.toContain('禁止补读')
        }
    })
})
