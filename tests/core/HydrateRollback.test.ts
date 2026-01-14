import { atom, createStore } from 'jotai/vanilla'
import { describe, expect, it, vi } from 'vitest'
import '../../src/core/mutation'
import { Executor } from '../../src/core/mutation/pipeline/Executor'
import { createMutationHooks } from '../../src/core/mutation/hooks'

describe('hydrate (A 语义)', () => {
    it('persist 失败 rollback 后仍保留补读 base 缓存', async () => {
        const store = createStore()
        const mapAtom = atom(new Map<any, any>())
        const hooks = createMutationHooks()

        const handle: any = {
            atom: mapAtom,
            jotaiStore: store,
            storeName: 'test',
            backend: { key: 'test' },
            indexes: null,
            services: { mutation: { hooks } },
            observability: { createContext: () => ({ traceId: 't', emit: vi.fn() }) }
        }

        const executor = new Executor()
        const executorAny = executor as any
        executorAny.directPersister = {
            persist: async () => {
                throw new Error('boom')
            }
        }

        const base = { id: '1', version: 1, createdAt: 1, updatedAt: 1 }
        const onFail = vi.fn()

        const operations: any[] = [
            { type: 'hydrate', handle, data: base, persist: 'direct' },
            { type: 'update', handle, data: { id: '1', name: 'n' }, persist: 'direct', onFail }
        ]

        const plan = executor.planner.plan(operations as any, store.get(mapAtom) as any)

        await executor.run({
            handle,
            operations: operations as any,
            plan: plan as any,
            atom: mapAtom,
            store,
            indexes: null,
            observabilityContext: { traceId: 't', emit: vi.fn() } as any,
            storeName: 'test',
            opContext: { scope: 'default', origin: 'user', actionId: 'a' }
        })

        expect(onFail).toHaveBeenCalledTimes(1)
        expect(store.get(mapAtom).get('1')).toEqual(base)
    })
})
