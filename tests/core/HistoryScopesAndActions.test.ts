import { describe, it, expect } from 'vitest'
import { defineEntities } from '../../src/react'
import type { BaseEntity, Entity, IAdapter, StoreKey } from '../../src/core/types'

type ItemEntity = BaseEntity & {
    name: string
}

type Entities = {
    items: ItemEntity
}

function createMockAdapter<T extends Entity>(): IAdapter<T> {
    return {
        name: 'mock',
        put: async () => { },
        bulkPut: async () => { },
        delete: async () => { },
        bulkDelete: async () => { },
        get: async () => undefined,
        bulkGet: async () => [],
        getAll: async () => [],
        applyPatches: async () => { }
    }
}

const createClient = () => {
    return defineEntities<Entities>()
        .defineStores()
        .defineClient({
            defaultAdapterFactory: () => createMockAdapter<any>()
        })
}

describe('History scopes & actions (in-memory)', () => {
    it('隔离不同 scope 的 undo/redo 栈', async () => {
        const client = createClient()
        const store = client.Store('items')

        const sheetA = client.scope('SheetA')
        const sheetB = client.scope('SheetB')

        await sheetA.Store('items').addOne({ id: 1 as StoreKey, name: 'a' } as any)
        await sheetB.Store('items').addOne({ id: 2 as StoreKey, name: 'b' } as any)

        expect(sheetA.canUndo()).toBe(true)
        expect(sheetB.canUndo()).toBe(true)

        const okA = await sheetA.undo()
        expect(okA).toBe(true)
        expect(store.getCachedOneById(1 as any)).toBe(undefined)
        expect(store.getCachedOneById(2 as any)?.name).toBe('b')

        expect(sheetA.canRedo()).toBe(true)
        expect(sheetB.canUndo()).toBe(true)

        const okB = await sheetB.undo()
        expect(okB).toBe(true)
        expect(store.getCachedOneById(2 as any)).toBe(undefined)

        const okA2 = await sheetA.redo()
        expect(okA2).toBe(true)
        expect(store.getCachedOneById(1 as any)?.name).toBe('a')
    })

    it('origin=sync 的写入不进入 history', async () => {
        const client = createClient()
        const store = client.Store('items')

        const syncScope = client.scope('Any', { origin: 'sync' })
        await syncScope.Store('items').addOne({ id: 1 as StoreKey, name: 'x' } as any)

        expect(syncScope.canUndo()).toBe(false)
        expect(store.getCachedOneById(1 as any)?.name).toBe('x')
    })

    it('beginAction 会把多个写入聚合成一次撤销单位', async () => {
        const client = createClient()
        const store = client.Store('items')

        const sheet = client.scope('Sheet')
        const action = sheet.beginAction({ label: 'Group' })

        await action.Store('items').addOne({ id: 1 as StoreKey, name: 'x' } as any)
        await action.Store('items').addOne({ id: 2 as StoreKey, name: 'y' } as any)
        action.commit()

        expect(sheet.canUndo()).toBe(true)

        await sheet.undo()
        expect(store.getCachedOneById(1 as any)).toBe(undefined)
        expect(store.getCachedOneById(2 as any)).toBe(undefined)

        await sheet.redo()
        expect(store.getCachedOneById(1 as any)?.name).toBe('x')
        expect(store.getCachedOneById(2 as any)?.name).toBe('y')
    })
})

