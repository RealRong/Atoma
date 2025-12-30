import { describe, expect, it } from 'vitest'
import { atom } from 'jotai/vanilla'
import { enableMapSet, enablePatches } from 'immer'
import { Reducer } from '../../src/core/mutation/pipeline/Reducer'

enableMapSet()
enablePatches()

type Todo = {
    id: string
    version: number
    nested: { x: number }
}

describe('Reducer.forceRemove appliedData: no revoked proxy leak', () => {
    it('appliedData should be safe to read after finishDraft', () => {
        const reducer = new Reducer()
        const current = new Map<string, Todo>([
            ['t1', { id: 't1', version: 1, nested: { x: 1 } }]
        ])

        const plan = reducer.reduce([{
            type: 'forceRemove',
            data: { id: 't1' } as any,
            handle: { atom: atom(new Map()) } as any
        }], current)

        expect(() => {
            void (plan.appliedData[0] as any).id
            void (plan.appliedData[0] as any).nested?.x
        }).not.toThrow()
        expect((plan.appliedData[0] as any).id).toBe('t1')
    })
})

