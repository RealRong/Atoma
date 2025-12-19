import { applyPatches, createDraft, finishDraft, Patch, WritableDraft } from 'immer'
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

        if (operations.length === 1 && operations[0]?.type === 'patches') {
            const op = operations[0]
            const patches = op.patches
            const inversePatches = op.inversePatches
            const newValue = applyPatches(currentValue as any, patches) as any
            const changedFields = this.collectChangedFieldsFromPatches(patches)
            return {
                newValue,
                patches,
                inversePatches,
                changedFields,
                appliedData: [],
                operationTypes: ['patches'],
                atom
            }
        }

        if (operations.some(o => o.type === 'patches')) {
            throw new Error('[Atoma] OperationApplier.apply: patches 操作不能与其他操作混合批处理')
        }

        const draft = createDraft(currentValue)
        const appliedData: T[] = []
        const operationTypes: StoreDispatchEvent<T>['type'][] = []

        operations.forEach(event => {
            switch (event.type) {
                case 'add':
                    draft.set(event.data.id, event.data as any)
                    appliedData.push(event.data as T)
                    operationTypes.push('add')
                    break
                case 'update': {
                    if (!draft.has(event.data.id)) {
                        event.onFail?.(new Error(`Item ${event.data.id} not found`))
                        return
                    }
                    const origin = draft.get(event.data.id)
                    // Ensure origin exists
                    if (!origin) return

                    const candidate = Object.assign({}, origin, event.data, { updatedAt: Date.now() })
                    const next = event.transformData
                        ? (event.transformData(candidate as any) as any)
                        : candidate
                    if (!next) return

                    const nextObj = next as any
                    const originObj = origin as unknown as WritableDraft<any>
                    const keys = new Set<string>([
                        ...Object.keys(originObj),
                        ...Object.keys(nextObj)
                    ])
                    keys.forEach(key => {
                        if (key === 'id') return
                        const has = Object.prototype.hasOwnProperty.call(nextObj, key)
                        if (!has) {
                            if (Object.prototype.hasOwnProperty.call(originObj, key)) {
                                delete originObj[key]
                            }
                            return
                        }
                        const nextVal = nextObj[key]
                        if (originObj[key] !== nextVal) {
                            originObj[key] = nextVal
                        }
                    })
                    originObj.id = event.data.id
                    appliedData.push(next as T)
                    operationTypes.push('update')
                    break
                }
                case 'forceRemove':
                    // 尽量保留被删除的原始值（用于版本/冲突处理、审计、离线队列等）
                    appliedData.push((draft.get(event.data.id) ?? currentValue.get(event.data.id) ?? event.data) as T)
                    draft.delete(event.data.id)
                    operationTypes.push('forceRemove')
                    break
                case 'remove': {
                    const origin = draft.get(event.data.id) ?? currentValue.get(event.data.id)
                    if (!origin) return
                    const newObj = Object.assign({}, origin, { deleted: true, deletedAt: Date.now() })
                    draft.set(event.data.id, newObj as any)
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

        const changedFields = this.collectChangedFieldsFromPatches(patches)

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

    private collectChangedFieldsFromPatches(patches: Patch[]): Set<string> {
        const fields = new Set<string>()
        patches.forEach(p => {
            if (p.path.length >= 2) {
                fields.add(String(p.path[1]))
                return
            }
            if (p.op === 'add' || p.op === 'replace') {
                fields.add('id')
            }
            if (p.op === 'remove') {
                fields.add('deleted')
            }
        })
        return fields
    }
}
