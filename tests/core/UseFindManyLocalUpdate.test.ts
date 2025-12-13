/** @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { atom, createStore } from 'jotai'
import { renderHook, act, waitFor } from '@testing-library/react'
import { initializeLocalStore } from '../../src/core/initializeLocalStore'
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

        localStore = initializeLocalStore(mapAtom, adapter, { store })
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
