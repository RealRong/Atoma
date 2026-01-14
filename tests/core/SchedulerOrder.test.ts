import { atom, createStore } from 'jotai/vanilla'
import { describe, expect, it, vi } from 'vitest'
import { Scheduler } from '../../src/core/mutation/pipeline/Scheduler'
import { createMutationHooks } from '../../src/core/mutation/hooks'

function deferred() {
    let resolve: (() => void) | undefined
    const promise = new Promise<void>((r) => {
        resolve = r
    })
    return { promise, resolve: resolve! }
}

describe('Scheduler', () => {
    it('保持同一 tick 内 dispatch 顺序稳定（即使 middleware 异步）', async () => {
        const store = createStore()
        const mapAtom = atom(new Map<any, any>())
        const hooks = createMutationHooks()

        const gateA = deferred()
        const gateB = deferred()

        hooks.middleware.beforeDispatch.use(async (ctx, next) => {
            const id = (ctx.event as any)?.data?.id
            if (id === 'a') await gateA.promise
            if (id === 'b') await gateB.promise
            return next(ctx)
        })

        let recorded: string[] = []
        let recordedActionId: string | undefined

        const done = deferred()

        const executor: any = {
            planner: {
                plan: (operations: any[], currentState: Map<any, any>) => {
                    recorded = operations.map(o => o.data?.id)
                    recordedActionId = operations[0]?.opContext?.actionId
                    return {
                        nextState: currentState,
                        patches: [],
                        inversePatches: [],
                        changedFields: new Set(),
                        appliedData: operations.map(o => o.data),
                        operationTypes: operations.map(o => o.type),
                        atom: mapAtom
                    }
                }
            },
            run: async () => {
                done.resolve()
            }
        }

        const handle: any = {
            atom: mapAtom,
            jotaiStore: store,
            storeName: 'test',
            services: { mutation: { hooks } },
            observability: { createContext: () => ({ traceId: 't', emit: vi.fn() }) }
        }

        const scheduler = new Scheduler({ executor })

        scheduler.enqueue({ type: 'update', handle, data: { id: 'a' }, persist: 'direct' } as any)
        scheduler.enqueue({ type: 'update', handle, data: { id: 'b' }, persist: 'direct' } as any)

        await Promise.resolve()
        gateB.resolve()
        gateA.resolve()

        await done.promise

        expect(recorded).toEqual(['a', 'b'])
        expect(typeof recordedActionId).toBe('string')
        expect(recordedActionId).toBeTruthy()
    })
})

