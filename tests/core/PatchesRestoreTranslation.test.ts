import { describe, expect, it } from 'vitest'
import type { EntityId } from '#protocol'
import { buildRestoreWriteItemsFromPatchesPlan, translatePlanToWrites } from '../../src/core/mutation/pipeline/persisters/writePlanTranslation'

describe('patches restore/replace translation', () => {
    it('统一翻译为 upsert + delete（包含 baseVersion）', () => {
        const plan: any = {
            operationTypes: ['patches'],
            patches: [
                { op: 'replace', path: ['a', 'name'], value: 'n' },
                { op: 'remove', path: ['b'] }
            ],
            inversePatches: [
                { op: 'add', path: ['b'], value: { id: 'b', version: 5 } }
            ],
            nextState: new Map<EntityId, any>([
                ['a', { id: 'a', version: 2, name: 'n' }]
            ])
        }

        const { upsertItems, deleteItems } = buildRestoreWriteItemsFromPatchesPlan({
            plan,
            metaForItem: () => ({ clientTimeMs: 123 })
        })

        expect(upsertItems).toHaveLength(1)
        expect((upsertItems[0] as any).entityId).toBe('a')
        expect((upsertItems[0] as any).baseVersion).toBe(2)
        expect((upsertItems[0] as any).meta.clientTimeMs).toBe(123)

        expect(deleteItems).toHaveLength(1)
        expect((deleteItems[0] as any).entityId).toBe('b')
        expect((deleteItems[0] as any).baseVersion).toBe(5)
        expect((deleteItems[0] as any).meta.clientTimeMs).toBe(123)
    })

    it('outbox 将 patches 翻译为 upsert(loose, merge=false) + delete', () => {
        const plan: any = {
            operationTypes: ['patches'],
            patches: [
                { op: 'replace', path: ['a', 'name'], value: 'n' },
                { op: 'remove', path: ['b'] }
            ],
            inversePatches: [
                { op: 'add', path: ['b'], value: { id: 'b', version: 5 } }
            ],
            nextState: new Map<EntityId, any>([
                ['a', { id: 'a', version: 2, name: 'n' }]
            ])
        }

        const writes = translatePlanToWrites({
            plan,
            operations: [],
            fallbackClientTimeMs: 123,
            mode: 'outbox'
        })

        expect(writes).toHaveLength(2)

        const upsert = writes.find(w => w.action === 'upsert')
        expect((upsert as any)?.options).toEqual({ merge: false, upsert: { mode: 'loose' } })
        expect((upsert as any)?.items?.length).toBe(1)

        const del = writes.find(w => w.action === 'delete')
        expect((del as any)?.items?.length).toBe(1)
    })
})
