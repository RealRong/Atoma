import { atom, createStore } from 'jotai/vanilla'
import { describe, expect, it, vi } from 'vitest'
import '../../src/core/mutation'
import { executeMutationFlow } from '../../src/core/mutation/pipeline/MutationFlow'

describe('hydrate (A 语义)', () => {
    it('persist 失败 rollback 后仍保留补读 base 缓存', async () => {
        const store = createStore()
        const mapAtom = atom(new Map<any, any>())

        const handle: any = {
            atom: mapAtom,
            jotaiStore: store,
            storeName: 'test',
            nextOpId: (() => {
                let seq = 0
                return () => `w_${++seq}`
            })(),
            indexes: null,
            hooks: undefined,
            schema: undefined,
            idGenerator: undefined,
            transform: (item: any) => item
        }

        const clientRuntime: any = {
            opsClient: {
                executeOps: async () => {
                    throw new Error('boom')
                }
            },
            createObservabilityContext: () => ({
                active: false,
                traceId: 't',
                requestId: () => 'r',
                emit: vi.fn(),
                with: () => ({ active: false, traceId: 't', requestId: () => 'r', emit: vi.fn(), with: () => ({}) })
            })
        }

        const base = { id: '1', version: 1, createdAt: 1, updatedAt: 1 }
        const onFail = vi.fn()

        const operations: any[] = [
            { type: 'hydrate', handle, data: base, persist: 'direct' },
            { type: 'update', handle, data: { id: '1', name: 'n' }, persist: 'direct', onFail }
        ]

        await executeMutationFlow(clientRuntime, {
            handle,
            operations: operations as any,
            opContext: { scope: 'default', origin: 'user', actionId: 'a' }
        })

        expect(onFail).toHaveBeenCalledTimes(1)
        expect(store.get(mapAtom).get('1')).toEqual(base)
    })
})
