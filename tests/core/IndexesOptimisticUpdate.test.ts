import { describe, it, expect, vi } from 'vitest'
import { atom, createStore } from 'jotai'
import { BaseStore } from '../../src/core/BaseStore'
import { createStoreRuntime } from '../../src/core/store/runtime'
import { createFindMany } from '../../src/core/store/findMany/index'
import type { Entity, IAdapter, StoreKey } from '../../src/core/types'

type Deferred<T> = {
    promise: Promise<T>
    resolve: (value: T) => void
    reject: (reason?: any) => void
}

const deferred = <T,>(): Deferred<T> => {
    let resolve!: (value: T) => void
    let reject!: (reason?: any) => void
    const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

interface TestItem extends Entity {
    id: StoreKey
    age: number
}

describe('StoreIndexes optimistic sync', () => {
    it('should update indexes for nested patches during optimistic update', async () => {
        const store = createStore()
        const mapAtom = atom(new Map<StoreKey, TestItem>())

        const apply = deferred<void>()

        const adapter = {
            name: 'test-adapter',
            applyPatches: vi.fn().mockImplementation(() => apply.promise),
            findMany: vi.fn().mockRejectedValue(new Error('no-remote'))
        } as unknown as IAdapter<TestItem>

        const runtime = createStoreRuntime<TestItem>({
            atom: mapAtom,
            adapter,
            config: {
                store,
                indexes: [{ field: 'age', type: 'number' }]
            }
        })

        const findMany = createFindMany<TestItem>(runtime)

        BaseStore.dispatch<TestItem>({
            type: 'add',
            atom: mapAtom,
            adapter,
            store,
            context: runtime.context,
            indexes: runtime.indexes,
            data: { id: '1', age: 10 }
        } as any)

        await Promise.resolve()

        BaseStore.dispatch<TestItem>({
            type: 'update',
            atom: mapAtom,
            adapter,
            store,
            context: runtime.context,
            indexes: runtime.indexes,
            data: { id: '1', age: 11 }
        } as any)

        await Promise.resolve()

        const resNew = await findMany({ where: { age: { eq: 11 } } })
        expect(resNew.data.map(i => i.id)).toEqual(['1'])

        const resOld = await findMany({ where: { age: { eq: 10 } } })
        expect(resOld.data.length).toBe(0)

        apply.resolve()
    })
})

