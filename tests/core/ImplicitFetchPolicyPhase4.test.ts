import { describe, expect, it, vi } from 'vitest'
import { createStore as createJotaiStore } from 'jotai/vanilla'
import { Core } from '../../src/core'
import type { IDataSource } from '../../src/core'

type Post = {
    id: string
    title: string
    createdAt: number
    updatedAt: number
    version?: number
    deleted?: boolean
    deletedAt?: number
}

function createTestAdapter(seed?: { id: string; version: number; title?: string }) {
    const now = Date.now()
    const row: Post | undefined = seed
        ? {
            id: seed.id,
            title: seed.title ?? 'seed',
            createdAt: now,
            updatedAt: now,
            version: seed.version
        }
        : undefined

    const adapter: IDataSource<Post> = {
        name: 'test',
        put: vi.fn(async () => { }),
        bulkPut: vi.fn(async () => { }),
        delete: vi.fn(async () => { }),
        bulkDelete: vi.fn(async () => { }),
        get: vi.fn(async () => row),
        bulkGet: vi.fn(async (keys) => keys.map(k => (row && k === row.id) ? row : undefined)),
        getAll: vi.fn(async () => [])
    }

    return { adapter }
}

describe('Phase4: implicit fetch policy for updateMany/deleteMany', () => {
    it('direct: updateMany 允许补读缺失项', async () => {
        const { adapter } = createTestAdapter({ id: 'p1', version: 1 })
        const store = Core.store.createStore<Post>({
            name: 'posts',
            dataSource: adapter,
            store: createJotaiStore()
        })

        const res = await store.updateMany([{
            id: 'p1',
            recipe: (draft) => {
                draft.title = 'next'
            }
        }])

        expect((adapter.bulkGet as any).mock.calls.length).toBe(1)
        expect(res[0]?.ok).toBe(true)
        expect(store.getCachedOneById('p1')?.title).toBe('next')
    })

    it('outbox: updateMany 禁止补读缺失项（返回明确错误）', async () => {
        const { adapter } = createTestAdapter({ id: 'p1', version: 1 })
        const store = Core.store.createStore<Post>({
            name: 'posts',
            dataSource: adapter,
            store: createJotaiStore()
        })

        const handle = Core.store.getHandle(store)
        if (!handle) throw new Error('missing handle')
        handle.writePolicies = { allowImplicitFetchForWrite: false }

        const res = await store.updateMany([{
            id: 'p1',
            recipe: (draft) => {
                draft.title = 'next'
            }
        }])

        expect((adapter.bulkGet as any).mock.calls.length).toBe(0)
        expect(res[0]?.ok).toBe(false)
        expect(String((res[0] as any).error?.message ?? '')).toMatch(/禁止补读/)
    })

    it('direct: deleteMany 允许补读缺失项并执行软删除', async () => {
        const { adapter } = createTestAdapter({ id: 'p1', version: 1 })
        const store = Core.store.createStore<Post>({
            name: 'posts',
            dataSource: adapter,
            store: createJotaiStore()
        })

        const res = await store.deleteMany(['p1'])
        expect((adapter.bulkGet as any).mock.calls.length).toBe(1)
        expect(res[0]?.ok).toBe(true)
        expect(store.getCachedOneById('p1')?.deleted).toBe(true)
    })

    it('outbox: deleteMany 禁止补读缺失项（返回明确错误）', async () => {
        const { adapter } = createTestAdapter({ id: 'p1', version: 1 })
        const store = Core.store.createStore<Post>({
            name: 'posts',
            dataSource: adapter,
            store: createJotaiStore()
        })

        const handle = Core.store.getHandle(store)
        if (!handle) throw new Error('missing handle')
        handle.writePolicies = { allowImplicitFetchForWrite: false }

        const res = await store.deleteMany(['p1'])
        expect((adapter.bulkGet as any).mock.calls.length).toBe(0)
        expect(res[0]?.ok).toBe(false)
        expect(String((res[0] as any).error?.message ?? '')).toMatch(/禁止补读/)
    })
})

