import { describe, it, expect, vi } from 'vitest'
import { atom, createStore } from 'jotai'
import { createStoreRuntime } from '../../src/core/store/runtime'
import { createAddOne } from '../../src/core/store/addOne'
import { createBatchGet } from '../../src/core/store/batchGet'
import { createDeleteOneById } from '../../src/core/store/deleteOneById'
import { createFindMany } from '../../src/core/store/findMany/index'
import { createGetAll } from '../../src/core/store/getAll'
import { createGetMultipleByIds } from '../../src/core/store/getMultipleByIds'
import { createUpdateOne } from '../../src/core/store/updateOne'
import type { Entity, IAdapter, StoreKey } from '../../src/core/types'

type Item = Entity & { id: StoreKey; name: string }

describe('findMany explain', () => {
    it('返回 explain（含 traceId/index/finalize/cacheWrite/adapter）', async () => {
        const store = createStore()
        const mapAtom = atom(new Map<StoreKey, Item>())

        const adapter: IAdapter<Item> = {
            name: 'mock',
            put: vi.fn(),
            bulkPut: vi.fn(),
            delete: vi.fn(),
            bulkDelete: vi.fn(),
            get: vi.fn(),
            bulkGet: vi.fn(),
            getAll: vi.fn().mockResolvedValue([]),
            findMany: vi.fn().mockResolvedValue({
                data: [
                    { id: 1, name: 'A' },
                    { id: 2, name: 'B' }
                ]
            })
        } as any

        store.set(mapAtom, new Map<StoreKey, Item>([
            [1, { id: 1, name: 'A' }],
            [2, { id: 2, name: 'B' }]
        ]))

        const runtime = createStoreRuntime<Item>({
            atom: mapAtom,
            adapter,
            config: {
                store,
                storeName: 'items',
                indexes: [{ field: 'name', type: 'string' }]
            }
        })
        const { getOneById, fetchOneById } = createBatchGet(runtime)
        const findMany = createFindMany<Item>(runtime)
        const localStore = {
            addOne: createAddOne<Item>(runtime),
            updateOne: createUpdateOne<Item>(runtime),
            deleteOneById: createDeleteOneById<Item>(runtime),
            getAll: createGetAll<Item>(runtime),
            getMultipleByIds: createGetMultipleByIds<Item>(runtime),
            getOneById,
            fetchOneById,
            findMany
        }

        const res = await localStore.findMany({
            where: { name: 'A' } as any,
            explain: true,
            traceId: 't_test'
        })

        expect(Array.isArray(res.data)).toBe(true)
        expect(res.explain?.traceId).toBe('t_test')
        expect(res.explain?.index?.lastQueryPlan?.whereFields).toEqual(['name'])
        expect(res.explain?.finalize?.outputCount).toBeGreaterThanOrEqual(0)
        expect(res.explain?.cacheWrite?.writeToCache).toBe(true)
        expect(res.explain?.adapter?.ok).toBe(true)
    })
})
