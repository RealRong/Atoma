import { createDraft, finishDraft, Patch } from 'immer'
import { PrimitiveAtom } from 'jotai'
import { StoreDispatchEvent, StoreKey } from '../types'

export type ApplyResult<T> = {
    newValue: Map<StoreKey, T>
    patches: Patch[]
    inversePatches: Patch[]
    changedFields: Set<string>
    appliedData: T[]
    atom: PrimitiveAtom<Map<StoreKey, T>>
}

/**
 * Applies operations to a Map (pure, aside from draft usage) and computes change metadata.
 */
export class OperationApplier {
    apply<T>(
        operations: StoreDispatchEvent<T>[],
        currentValue: Map<StoreKey, T>
    ): ApplyResult<T> {
        const atom = operations[0]?.atom as PrimitiveAtom<Map<StoreKey, T>>
        const draft = createDraft(currentValue)
        const appliedData: T[] = []

        operations.forEach(event => {
            const { data } = event
            switch (event.type) {
                case 'add':
                    draft.set(data.id, data as unknown as T)
                    appliedData.push(data as unknown as T)
                    break
                case 'update': {
                    if (!draft.has(data.id)) {
                        event.onFail?.(new Error(`Item ${data.id} not found`))
                        return
                    }
                    const origin = draft.get(data.id)
                    let newObj = Object.assign({}, origin, data, { updatedAt: Date.now() })
                    if (event.transformData) {
                        newObj = event.transformData(newObj)
                    }
                    if (!newObj) return
                    draft.set(data.id, newObj as unknown as T)
                    appliedData.push(newObj as unknown as T)
                    break
                }
                case 'forceRemove':
                    draft.delete(data.id)
                    appliedData.push(data as unknown as T)
                    break
                case 'remove': {
                    if (event.clearCache) {
                        draft.delete(data.id)
                    } else {
                        const origin = draft.get(data.id) ?? currentValue.get(data.id)
                        const newObj = Object.assign({}, origin, { deleted: true, deletedAt: Date.now() })
                        draft.set(data.id, newObj as unknown as T)
                        appliedData.push(newObj as unknown as T)
                    }
                    break
                }
            }
        })

        let inversePatches: Patch[] = []
        let patches: Patch[] = []
        const newValue = finishDraft(draft, (p, inverse) => {
            patches = p
            inversePatches = inverse
        })

        const changedFields = this.collectChangedFields(operations, currentValue)

        return {
            newValue,
            patches,
            inversePatches,
            changedFields,
            appliedData,
            atom
        }
    }

    private collectChangedFields<T>(
        events: StoreDispatchEvent<T>[],
        currentMap: Map<StoreKey, T>
    ): Set<string> {
        const fields = new Set<string>()
        events.forEach(event => {
            const { data, type } = event
            if (type === 'update') {
                const current = currentMap.get(data.id)
                if (!current) return
                Object.keys(data).forEach(key => {
                    if (key === 'id') return
                    if ((current as any)[key] !== (data as any)[key]) {
                        fields.add(key)
                    }
                })
            } else {
                Object.keys(data || {}).forEach(k => fields.add(k))
            }
        })
        return fields
    }
}
