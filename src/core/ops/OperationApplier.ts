import { createDraft, finishDraft, Patch, WritableDraft } from 'immer'
import { PrimitiveAtom } from 'jotai/vanilla'
import { StoreDispatchEvent, StoreKey, Entity } from '../types'

export type ApplyResult<T extends Entity> = {
    newValue: Map<StoreKey, T>
    patches: Patch[]
    inversePatches: Patch[]
    changedFields: Set<string>
    appliedData: T[]
    operationTypes: StoreDispatchEvent<T>['type'][]
    atom: PrimitiveAtom<Map<StoreKey, T>>
}

/**
 * Applies operations to a Map (pure, aside from draft usage) and computes change metadata.
 */
export class OperationApplier {
    apply<T extends Entity>(
        operations: StoreDispatchEvent<T>[],
        currentValue: Map<StoreKey, T>
    ): ApplyResult<T> {
        const atom = operations[0]?.atom as PrimitiveAtom<Map<StoreKey, T>>
        const draft = createDraft(currentValue)
        const appliedData: T[] = []
        const operationTypes: StoreDispatchEvent<T>['type'][] = []

        operations.forEach(event => {
            const { data } = event
            switch (event.type) {
                case 'add':
                    draft.set(data.id, data as any)
                    appliedData.push(data as T)
                    operationTypes.push('add')
                    break
                case 'update': {
                    if (!draft.has(data.id)) {
                        event.onFail?.(new Error(`Item ${data.id} not found`))
                        return
                    }
                    const origin = draft.get(data.id)
                    // Ensure origin exists
                    if (!origin) return

                    let newObj = Object.assign({}, origin, data, { updatedAt: Date.now() })
                    if (event.transformData) {
                        newObj = event.transformData(newObj as any) as any
                    }
                    if (!newObj) return
                    draft.set(data.id, newObj as any)
                    appliedData.push(newObj as T)
                    operationTypes.push('update')
                    break
                }
                case 'forceRemove':
                    // 尽量保留被删除的原始值（用于版本/冲突处理、审计、离线队列等）
                    appliedData.push((draft.get(data.id) ?? currentValue.get(data.id) ?? data) as T)
                    draft.delete(data.id)
                    operationTypes.push('forceRemove')
                    break
                case 'remove': {
                    const origin = draft.get(data.id) ?? currentValue.get(data.id)
                    if (!origin) return
                    const newObj = Object.assign({}, origin, { deleted: true, deletedAt: Date.now() })
                    draft.set(data.id, newObj as any)
                    appliedData.push(newObj as T)
                    operationTypes.push('remove')
                    break
                }
            }
        })

        let inversePatches: Patch[] = []
        let patches: Patch[] = []
        const newValue = finishDraft(draft, (p, inverse) => {
            patches = p
            inversePatches = inverse
        }) as Map<StoreKey, T>

        const changedFields = this.collectChangedFields(operations, currentValue)

        return {
            newValue,
            patches,
            inversePatches,
            changedFields,
            appliedData,
            operationTypes,
            atom
        }
    }

    private collectChangedFields<T extends Entity>(
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
