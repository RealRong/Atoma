/** @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { atom, createStore } from 'jotai'
import { renderHook, act, waitFor } from '@testing-library/react'
import { createStoreRuntime } from '../../src/core/store/runtime'
import { createAddOne } from '../../src/core/store/addOne'
import { createBatchGet } from '../../src/core/store/batchGet'
import { createDeleteOneById } from '../../src/core/store/deleteOneById'
import { createFindMany } from '../../src/core/store/findMany/index'
import { createGetAll } from '../../src/core/store/getAll'
import { createGetMultipleByIds } from '../../src/core/store/getMultipleByIds'
import { createUpdateOne } from '../../src/core/store/updateOne'
import { createUseFindMany } from '../../src/react/hooks/useFindMany'
import { Entity, IAdapter, StoreKey } from '../../src/core/types'

interface Post extends Entity {
    id: StoreKey
    title: string
    createdAt: number
}

const seedPost: Post = { id: 1, title: 'Old Title', createdAt: 1 }

describe('useFindMany local-then-remote 实时反映本地更新', () => {
    let store: ReturnType<typeof createStore>
    let mapAtom: any
    let adapter: IAdapter<Post>
    let localStore: any

    beforeEach(() => {
        store = createStore()
        mapAtom = atom(new Map<StoreKey, Post>())
        adapter = {
            name: 'mock',
            findMany: vi.fn().mockResolvedValue({ data: [seedPost] }),
            bulkPut: vi.fn().mockResolvedValue(undefined),
            bulkDelete: vi.fn(),
            bulkGet: vi.fn(),
            getAll: vi.fn().mockResolvedValue([]),
            get: vi.fn(),
            delete: vi.fn(),
            bulkCreate: vi.fn(),
            put: vi.fn()
        } as unknown as IAdapter<Post>

        const runtime = createStoreRuntime<Post>({ atom: mapAtom, adapter, config: { store } })
        const { getOneById, fetchOneById } = createBatchGet(runtime)
        const findMany = createFindMany<Post>(runtime)
        localStore = {
            addOne: createAddOne<Post>(runtime),
            updateOne: createUpdateOne<Post>(runtime),
            deleteOneById: createDeleteOneById<Post>(runtime),
            getAll: createGetAll<Post>(runtime),
            getMultipleByIds: createGetMultipleByIds<Post>(runtime),
            getOneById,
            fetchOneById,
            findMany
        }
    })

    it('updateOne 后无需刷新即可看到新标题', async () => {
        const useFindMany = createUseFindMany(mapAtom, localStore, store)

        const { result } = renderHook(() => useFindMany({ fetchPolicy: 'local-then-remote' }))
        await waitFor(() => expect(result.current.loading).toBe(false))
        expect(result.current.data[0].title).toBe('Old Title')

        await act(async () => {
            await localStore.updateOne({ id: 1, title: 'New Title' })
        })

        await waitFor(() => {
            expect(result.current.data[0].title).toBe('New Title')
        })
    })
})
