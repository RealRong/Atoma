/**
 * Mutation Pipeline: Local Plan
 * Purpose: Builds base/optimistic state, patches, and write intents for a batch of dispatch events.
 * Call chain: buildMutationProgram -> buildLocalMutationPlan -> deriveOptimisticState -> buildWriteIntentsFromEvents/buildWriteIntentsFromPatches.
 */
import { applyPatches, createDraft, finishDraft, type Draft, type Patch, type WritableDraft } from 'immer'
import type { EntityId } from '#protocol'
import type { Entity, StoreDispatchEvent } from '../../types'
import type { LocalMutationPlan, PersistMode } from './types'
import { buildWriteIntentsFromEvents, buildWriteIntentsFromPatches } from './WriteIntents'

export function buildLocalMutationPlan<T extends Entity>({ operations, currentState, fallbackClientTimeMs, persistMode }: {
    operations: Array<StoreDispatchEvent<T>>
    currentState: Map<EntityId, T>
    fallbackClientTimeMs: number
    persistMode: PersistMode
}): LocalMutationPlan<T> {
    const base = applyHydrateToBaseState({
        baseState: currentState,
        operations
    })

    const { writeEvents, hasCreate, hasPatches } = validateAndCollectWriteEvents(operations)

    const optimistic = deriveOptimisticState({
        baseState: base.baseState,
        writeEvents,
        hasCreate,
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
                fallbackClientTimeMs,
                persistMode
            }))

    return {
        baseState: base.baseState,
        optimisticState: optimistic.optimisticState,
        writeEvents,
        writeIntents,
        hasCreate,
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
    let batchKind: 'create' | 'patches' | 'writes' | undefined

    for (const e of operations) {
        if (e.type === 'hydrate' || e.type === 'hydrateMany') continue
        writeEvents.push(e)

        const kind: 'create' | 'patches' | 'writes' =
            e.type === 'create'
                ? 'create'
                : e.type === 'patches'
                    ? 'patches'
                    : 'writes'

        if (!batchKind) {
            batchKind = kind
            continue
        }

        if (batchKind === kind) continue

        // create/patches must be exclusive in a segment; writes cannot mix with them
        if (batchKind === 'create' || kind === 'create') {
            throw new Error('[Atoma] create operations cannot be batched with other operations')
        }
        throw new Error('[Atoma] patches operations cannot be batched with other operations')
    }

    return {
        writeEvents,
        hasCreate: batchKind === 'create',
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
    hasCreate: boolean
    hasPatches: boolean
}): { optimisticState: Map<EntityId, T>; patches: Patch[]; inversePatches: Patch[]; changedIds: Set<EntityId> } {
    const { baseState, writeEvents, hasCreate, hasPatches } = args

    const changedIds = new Set<EntityId>()
    let patches: Patch[] = []
    let inversePatches: Patch[] = []

    if (writeEvents.length === 0 || hasCreate) {
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

                const merge = event.upsert?.merge !== false
                const candidate: DraftEntityObject = merge
                    ? Object.assign({}, origin as unknown as DraftEntityObject, event.data as unknown as DraftEntityObject, { updatedAt: now })
                    : Object.assign({}, event.data as unknown as DraftEntityObject, { updatedAt: now })

                const originObj = origin as unknown as WritableDraft<DraftEntityObject>
                syncObjectIntoDraft(originObj, candidate)
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

                const candidate = Object.assign({}, origin, event.data, { updatedAt: now })
                const next = event.transformData
                    ? event.transformData(candidate as T)
                    : candidate
                if (!next) break

                const originObj = origin as unknown as WritableDraft<DraftEntityObject>
                syncObjectIntoDraft(originObj, next as unknown as DraftEntityObject)
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
            case 'create':
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
