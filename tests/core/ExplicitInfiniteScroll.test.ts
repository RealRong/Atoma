
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { initializeLocalStore } from '../../src/core/initializeLocalStore'
import { atom, createStore } from 'jotai'
import { IAdapter, StoreKey, Entity } from '../../src/core/types'
import { createUseFindMany } from '../../src/hooks/useFindMany'
import { renderHook, act, waitFor } from '@testing-library/react'

interface TestItem extends Entity {
    id: StoreKey
    name: string
}

const mockDataPage1 = [
    { id: '1', name: 'Item 1' },
    { id: '2', name: 'Item 2' }
]

const mockDataPage2 = [
    { id: '3', name: 'Item 3' },
    { id: '4', name: 'Item 4' }
]

const createMockAdapter = () => {
    return {
        name: 'test-adapter',
        put: vi.fn(),
        bulkPut: vi.fn(),
        delete: vi.fn(),
        bulkDelete: vi.fn(),
        get: vi.fn(),
        bulkGet: vi.fn(),
        getAll: vi.fn().mockResolvedValue([]),
        findMany: vi.fn().mockImplementation(async (opts) => {
            if (opts.offset === 2) return mockDataPage2
            return mockDataPage1
        })
    } as unknown as IAdapter<TestItem>
}

describe('useFindMany Infinite Scroll (fetchMore)', () => {
    let store: ReturnType<typeof createStore>
    let mapAtom: any
    let adapter: IAdapter<TestItem>
    let localStore: any

    beforeEach(() => {
        store = createStore()
        mapAtom = atom(new Map<StoreKey, TestItem>())
        adapter = createMockAdapter()
        localStore = initializeLocalStore(mapAtom, adapter, { store })
    })

    it('should support explicit infinite scroll in Store Mode', async () => {
        const useFindMany = createUseFindMany(mapAtom, localStore, store)

        // Initial Render with Limit 2
        const { result } = renderHook(() => useFindMany({ limit: 2, offset: 0, fetchPolicy: 'local-then-remote' }))

        await waitFor(() => expect(result.current.loading).toBe(false))
        expect(result.current.data).toHaveLength(2)
        expect(result.current.data[0].id).toBe('1')

        // Fetch More (Page 2)
        await act(async () => {
            const newItems = await result.current.fetchMore({ offset: 2, limit: 2 })
            expect(newItems).toHaveLength(2)
            expect(newItems[0].id).toBe('3')
        })

        // NOTE: In Explicit Mode, simply calling fetchMore puts data in store, 
        // BUT does NOT change the returned 'data' length UNLESS properties change or we use local-then-remote with updated limit.
        // Wait, 'local-then-remote' extracts fields/query logic locally.
        // If we didn't update the `limit` passed to the hook, `localData` logic inside hook 
        // will still slice at the original limit (2).

        // Let's verify store has 4 items
        const map = store.get(mapAtom)
        expect(map.size).toBe(4)

        // The hook data should still be 2 (because we enforce limit 2 from props)
        expect(result.current.data).toHaveLength(2)

        // Now Simulate User Increasing Limit to 4
        // In a real component this would be a re-render with new props
        const { result: result2 } = renderHook(() => useFindMany({ limit: 4, offset: 0, fetchPolicy: 'local-then-remote' }))
        expect(result2.current.data).toHaveLength(4)
    })

    it('should support explicit infinite scroll in Transient Mode', async () => {
        const useFindMany = createUseFindMany(mapAtom, localStore, store)

        // Initial Render
        // For Transient mode, fetchPolicy should be 'remote' (implied or explicit) usually, 
        // but 'local-then-remote' with skipStore works too (just no local data initially).
        // Let's use 'remote' for simplicity in transient cases.
        const { result } = renderHook(() => useFindMany({
            limit: 2,
            offset: 0,
            fetchPolicy: 'remote',
            skipStore: true
        }))

        await waitFor(() => expect(result.current.loading).toBe(false))
        expect(result.current.data).toHaveLength(2) // Initial fetched

        // Fetch More
        await act(async () => {
            await result.current.fetchMore({ offset: 2, limit: 2 })
        })

        // In Transient Mode, we DO append to state manually in fetchMore implementation
        // So this logic SHOULD see 4 items immediately even without manual limit update?
        // Let's check implementation behavior:
        // `setRemoteData(prev => [...prev, ...data])`
        // So yes, Transient Mode behaves like "append to list", whereas Store Mode behaves like "cache management".
        // This distinction is actually quite nice for Feeds vs Tables.

        expect(result.current.data).toHaveLength(4)
        expect(result.current.data[2].id).toBe('3')
    })
})
