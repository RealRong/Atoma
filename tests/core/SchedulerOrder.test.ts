import { atom, createStore } from 'jotai/vanilla'
import { describe, expect, it, vi } from 'vitest'
import { Scheduler } from '../../packages/atoma/src/core/mutation/pipeline/Scheduler'

describe('Scheduler', () => {
    it('保持同一 tick 内 dispatch 顺序稳定', async () => {
        const store = createStore()
        const mapAtom = atom(new Map<any, any>())

        let recorded: string[] = []
        let recordedActionId: string | undefined

        let resolveDone: (() => void) | undefined
        const done = new Promise<void>((r) => {
            resolveDone = r
        })

        const executor: any = {
            run: async (args: any) => {
                recorded = (args.operations ?? []).map((o: any) => o.data?.id)
                recordedActionId = args.opContext?.actionId
                resolveDone?.()
            }
        }

        const handle: any = {
            atom: mapAtom,
            jotaiStore: store,
            storeName: 'test'
        }

        const scheduler = new Scheduler({ run: executor.run })

        scheduler.enqueue({ type: 'update', handle, data: { id: 'a' }, persist: 'direct' } as any)
        scheduler.enqueue({ type: 'update', handle, data: { id: 'b' }, persist: 'direct' } as any)

        await done

        expect(recorded).toEqual(['a', 'b'])
        expect(typeof recordedActionId).toBe('string')
        expect(recordedActionId).toBeTruthy()
    })
})
