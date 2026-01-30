import { describe, expect, it } from 'vitest'
import type { EntityId } from 'atoma-protocol'
import { buildRestoreWriteItemsFromPatches, buildWriteIntentsFromPatches } from '../../packages/atoma/src/core/mutation/pipeline/WriteIntents'
import { translateWriteIntentsToOps } from '../../packages/atoma/src/core/mutation/pipeline/WriteOps'

describe('patches restore/replace translation', () => {
    it('统一翻译为 upsert + delete（包含 baseVersion）', () => {
        const patchesOp: any = {
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

        const { upsertItems, deleteItems } = buildRestoreWriteItemsFromPatches({
            nextState: patchesOp.nextState,
            patches: patchesOp.patches,
            inversePatches: patchesOp.inversePatches,
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
        const patchesOp: any = {
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

        const handle: any = {
            storeName: 'store',
            nextOpId: (() => {
                let seq = 0
                return () => `w_${++seq}`
            })()
        }

        const intents = buildWriteIntentsFromPatches({
            optimisticState: patchesOp.nextState,
            patches: patchesOp.patches,
            inversePatches: patchesOp.inversePatches,
            fallbackClientTimeMs: 123
        })
        const ops = translateWriteIntentsToOps({ handle, intents })

        expect(ops).toHaveLength(2)

        const upsert = ops.find(o => o.action === 'upsert')
        expect((upsert as any)?.op?.write?.options).toEqual({ merge: false, upsert: { mode: 'loose' } })

        const del = ops.find(o => o.action === 'delete')
        expect((del as any)?.op).toBeTruthy()
    })
})
