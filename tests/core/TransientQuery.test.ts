
import { describe, it, expect, vi } from 'vitest'
import { initializeLocalStore } from '../../src/core/initializeLocalStore'
import { atom, createStore } from 'jotai'
import { IAdapter, StoreKey, Entity, FindManyOptions } from '../../src/core/types'

interface TestItem extends Entity {
    id: StoreKey
    name: string
}

// Mock Adapter
const createMockAdapter = () => {
    return {
        name: 'test-adapter',
        put: vi.fn(),
        bulkPut: vi.fn(),
        delete: vi.fn(),
        bulkDelete: vi.fn(),
        get: vi.fn(),
        bulkGet: vi.fn().mockResolvedValue([]),
        getAll: vi.fn().mockResolvedValue([
            { id: '1', name: 'Remote Item 1' },
            { id: '2', name: 'Remote Item 2' }
        ]),
        findMany: vi.fn().mockResolvedValue([
            { id: '1', name: 'Remote Item 1' },
            { id: '2', name: 'Remote Item 2' }
        ])
    } as unknown as IAdapter<TestItem>
}

describe('Transient Queries (skipStore)', () => {
    it('should NOT update store when skipStore is true', async () => {
        const store = createStore()
        const mapAtom = atom(new Map<StoreKey, TestItem>())
        const adapter = createMockAdapter()

        const localStore = initializeLocalStore(mapAtom, adapter, {
            store,
            // Add index to ensure we also skip indexing
            indexes: [{ field: 'name', type: 'string' }]
        })

        // 1. Verify store is empty initially
        expect(store.get(mapAtom).size).toBe(0)

        // 2. Perform findMany with skipStore: true
        const start = Date.now()
        const results = await localStore.findMany({ skipStore: true })
        // const results = await localStore.getAll(undefined) // initializeLocalStore implementation differentiates findMany (smart) vs getAll (dumb) logic, we patched both if skipStore is passed via options.
        // Wait, getAll doesn't accept options object in the interface IStore<T>['getAll'] -> (filter, cacheFilter).
        // But findMany does.
        // Let's test the IStore.findMany path which is what useFindMany uses.

        // 3. Verify we got data
        expect(results).toHaveLength(2)
        expect((results as any)[0].name).toBe('Remote Item 1')

        // 4. Verify store is STILL empty
        expect(store.get(mapAtom).size).toBe(0)

        // 5. Perform standard findMany (without skipStore)
        await localStore.findMany({})

        // 6. Verify store is now populated
        expect(store.get(mapAtom).size).toBe(2)
    })
})
