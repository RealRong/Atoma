/**
 * Mutation Pipeline: Local Plan
 * Purpose: Builds base/optimistic state, patches, and write intents for a batch of dispatch events.
 * Call chain: buildMutationProgram -> buildLocalMutationPlan -> deriveOptimisticState -> buildWriteIntentsFromEvents/buildWriteIntentsFromPatches.
 */
import { applyPatches, createDraft, finishDraft, type Draft, type Patch, type WritableDraft } from 'immer'
import type { EntityId } from 'atoma-protocol'
import type { Entity, StoreDispatchEvent } from 'atoma-core/internal'
import type { LocalMutationPlan } from './types'
import { buildWriteIntentsFromEvents, buildWriteIntentsFromPatches } from './WriteIntents'

export function buildLocalMutationPlan<T extends Entity>({ operations, currentState, fallbackClientTimeMs }: {
    operations: Array<StoreDispatchEvent<T>>
    currentState: Map<EntityId, T>
    fallbackClientTimeMs: number
}): LocalMutationPlan<T> {
    const base = applyHydrateToBaseState({
        baseState: currentState,
        operations
    })

    const { writeEvents, hasPatches } = validateAndCollectWriteEvents(operations)

    const optimistic = deriveOptimisticState({
        baseState: base.baseState,
        writeEvents,
        hasPatches
    })

    const changedIds = new Set<EntityId>()
    unionInto(changedIds, base.changedIds)
    unionInto(changedIds, optimistic.changedIds)

    const writeIntents = (writeEvents.length === 0)
        ? []
        : (hasPatches
            ? buildWriteIntentsFromPatches({
                optimisticState: optimistic.optimisticState,
                patches: optimistic.patches,
                inversePatches: optimistic.inversePatches,
                fallbackClientTimeMs
            })
            : buildWriteIntentsFromEvents({
                writeEvents,
                optimisticState: optimistic.optimisticState,
                baseState: base.baseState,
                fallbackClientTimeMs
            }))

    return {
        baseState: base.baseState,
        optimisticState: optimistic.optimisticState,
        writeEvents,
        writeIntents,
        hasPatches,
        changedIds,
        patches: optimistic.patches,
        inversePatches: optimistic.inversePatches
    }
}

function cloneMapIfNeeded<T>(current: Map<EntityId, T>, next: Map<EntityId, T> | null): Map<EntityId, T> {
    if (next) return next
    return new Map(current)
}

function unionInto<T>(target: Set<T>, source: Iterable<T>) {
    for (const item of source) target.add(item)
}

function applyHydrateToBaseState<T extends Entity>(args: {
    baseState: Map<EntityId, T>
    operations: Array<StoreDispatchEvent<T>>
}): { baseState: Map<EntityId, T>; changedIds: Set<EntityId> } {
    const { baseState, operations } = args

    let nextState: Map<EntityId, T> | null = null
    const changedIds = new Set<EntityId>()

    for (const op of operations) {
        if (op.type === 'hydrate') {
            const { id } = op.data
            if (nextState ? nextState.has(id) : baseState.has(id)) continue
            nextState = cloneMapIfNeeded(baseState, nextState)
            nextState.set(id, op.data as unknown as T)
            changedIds.add(id)
            continue
        }

        if (op.type === 'hydrateMany') {
            for (const item of op.items) {
                const { id } = item
                if (nextState ? nextState.has(id) : baseState.has(id)) continue
                nextState = cloneMapIfNeeded(baseState, nextState)
                nextState.set(id, item as unknown as T)
                changedIds.add(id)
            }
        }
    }

    return { baseState: nextState ?? baseState, changedIds }
}

function validateAndCollectWriteEvents<T extends Entity>(operations: Array<StoreDispatchEvent<T>>) {
    const writeEvents: Array<StoreDispatchEvent<T>> = []
    let batchKind: 'patches' | 'writes' | undefined

    for (const e of operations) {
        if (e.type === 'hydrate' || e.type === 'hydrateMany') continue
        writeEvents.push(e)

        const kind: 'patches' | 'writes' = (e.type === 'patches') ? 'patches' : 'writes'

        if (!batchKind) {
            batchKind = kind
            continue
        }

        if (batchKind === kind) continue

        throw new Error('[Atoma] patches operations cannot be batched with other operations')
    }

    return {
        writeEvents,
        hasPatches: batchKind === 'patches'
    }
}

type DraftEntityObject = { id: EntityId } & Record<string, unknown>

function syncObjectIntoDraft(originObj: WritableDraft<DraftEntityObject>, nextObj: DraftEntityObject) {
    const keys = new Set<string>([
        ...Object.keys(originObj),
        ...Object.keys(nextObj)
    ])

    for (const key of keys) {
        if (key === 'id') continue

        // Delete keys that are missing in nextObj (keep draft in sync, but preserve reference when unchanged)
        if (!Object.prototype.hasOwnProperty.call(nextObj, key)) {
            if (Object.prototype.hasOwnProperty.call(originObj, key)) {
                delete originObj[key]
            }
            continue
        }

        const nextVal = nextObj[key]
        if (originObj[key] !== nextVal) originObj[key] = nextVal
    }
}

function collectChangedIdsFromPatches(patches: Patch[], changedIds: Set<EntityId>) {
    for (const p of patches) {
        const root = p.path?.[0]
        if (typeof root === 'string' && root) changedIds.add(root as EntityId)
    }
}

function deriveOptimisticState<T extends Entity>(args: {
    baseState: Map<EntityId, T>
    writeEvents: Array<StoreDispatchEvent<T>>
    hasPatches: boolean
}): { optimisticState: Map<EntityId, T>; patches: Patch[]; inversePatches: Patch[]; changedIds: Set<EntityId> } {
    const { baseState, writeEvents, hasPatches } = args

    const changedIds = new Set<EntityId>()
    let patches: Patch[] = []
    let inversePatches: Patch[] = []

    if (writeEvents.length === 0) {
        return {
            optimisticState: baseState,
            patches,
            inversePatches,
            changedIds
        }
    }

    if (hasPatches) {
        const patchesOp = writeEvents[0]
        if (!patchesOp || patchesOp.type !== 'patches') {
            throw new Error('[Atoma] invalid patches operation')
        }
        patches = patchesOp.patches
        inversePatches = patchesOp.inversePatches
        const optimisticState = applyPatches(baseState, patches) as Map<EntityId, T>

        collectChangedIdsFromPatches(patches, changedIds)

        return {
            optimisticState,
            patches,
            inversePatches,
            changedIds
        }
    }

    const draft = createDraft(baseState)
    const setDraft = (id: EntityId, value: unknown) => {
        draft.set(id, value as Draft<T>)
    }
    const now = Date.now()

    for (const event of writeEvents) {
        switch (event.type) {
            case 'add':
                setDraft(event.data.id, event.data)
                break
            case 'upsert': {
                const id = event.data.id
                if (!draft.has(id)) {
                    setDraft(id, event.data)
                    break
                }

                const origin = draft.get(id)
                if (!origin) {
                    setDraft(id, event.data)
                    break
                }

                const originObj = origin as unknown as WritableDraft<DraftEntityObject>
                syncObjectIntoDraft(originObj, event.data as unknown as DraftEntityObject)
                originObj.id = id
                break
            }
            case 'update': {
                if (!draft.has(event.data.id)) {
                    event.onFail?.(new Error(`Item ${event.data.id} not found`))
                    break
                }
                const origin = draft.get(event.data.id)
                if (!origin) break

                const originObj = origin as unknown as WritableDraft<DraftEntityObject>
                syncObjectIntoDraft(originObj, event.data as unknown as DraftEntityObject)
                originObj.id = event.data.id
                break
            }
            case 'forceRemove':
                draft.delete(event.data.id)
                break
            case 'remove': {
                const origin = draft.get(event.data.id) ?? baseState.get(event.data.id)
                if (!origin) break
                const newObj = Object.assign({}, origin, { deleted: true, deletedAt: now })
                setDraft(event.data.id, newObj)
                break
            }
            case 'patches':
            case 'hydrate':
            case 'hydrateMany':
                break
        }
    }

    const optimisticState = finishDraft(draft, (p, inverse) => {
        patches = p
        inversePatches = inverse
    }) as Map<EntityId, T>

    collectChangedIdsFromPatches(patches, changedIds)

    return {
        optimisticState,
        patches,
        inversePatches,
        changedIds
    }
}
