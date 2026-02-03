import { produce, type Draft, type Patch } from 'immer'
import type { Draft as ImmerDraft } from 'immer'
import type * as Types from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import type { CoreRuntime, RuntimeWrite, StoreHandle } from 'atoma-types/runtime'
import { version } from 'atoma-shared'
import { applyPersistAck } from './write/finalize'
import { buildWriteIntentsFromPatches, buildWriteOps } from '../persistence'
import { ensureActionId, prepareForAdd, prepareForUpdate, resolveBaseForWrite, runAfterSave, runBeforeSave } from './write/prepare'
import { applyIntentsOptimistically } from './write/optimistic'

function buildUpsertIntentOptions(options?: Types.UpsertWriteOptions): Types.WriteIntentOptions | undefined {
    if (!options) return undefined
    const out: Types.WriteIntentOptions = {}
    if (typeof options.merge === 'boolean') out.merge = options.merge
    if (options.mode === 'strict' || options.mode === 'loose') out.upsert = { mode: options.mode }
    return Object.keys(out).length ? out : undefined
}

function buildRootPatches<T>(args: {
    id: EntityId
    before?: T
    after?: T
    remove?: boolean
}): { patches: Patch[]; inversePatches: Patch[] } {
    const id = args.id
    const before = args.before
    const after = args.after
    const hasBefore = before !== undefined
    const hasAfter = after !== undefined

    if (args.remove) {
        const patches: Patch[] = [{ op: 'remove', path: [id] as any }]
        const inversePatches: Patch[] = hasBefore
            ? [{ op: 'add', path: [id] as any, value: before } as any]
            : []
        return { patches, inversePatches }
    }

    if (!hasAfter) {
        return { patches: [], inversePatches: [] }
    }

    if (hasBefore) {
        return {
            patches: [{ op: 'replace', path: [id] as any, value: after } as any],
            inversePatches: [{ op: 'replace', path: [id] as any, value: before } as any]
        }
    }

    return {
        patches: [{ op: 'add', path: [id] as any, value: after } as any],
        inversePatches: [{ op: 'remove', path: [id] as any }]
    }
}

function resolveOutputFromAck<T extends Types.Entity>(intent: Types.WriteIntent<T> | undefined, ack: Types.PersistAck<T> | undefined, fallback?: T): T | undefined {
    if (!ack) return fallback
    if (!intent) return fallback

    if (intent.action === 'create' && ack.created?.length) {
        return ack.created[0] as T
    }

    if ((intent.action === 'update' || intent.action === 'upsert') && ack.upserts?.length) {
        const id = intent.entityId as EntityId | undefined
        if (!id) return ack.upserts[0] as T
        const matched = ack.upserts.find(item => (item as any)?.id === id)
        return (matched ?? ack.upserts[0]) as T
    }

    return fallback
}

async function prepareAddIntent<T extends Types.Entity>(args: {
    runtime: CoreRuntime
    handle: StoreHandle<T>
    item: Partial<T>
    opContext: Types.OperationContext
}): Promise<{ intent: Types.WriteIntent<T>; output: T }> {
    const prepared = await prepareForAdd(args.runtime, args.handle, args.item, args.opContext)
    return {
        intent: {
            action: 'create',
            entityId: prepared.id as EntityId,
            value: prepared as T,
            intent: 'created'
        },
        output: prepared as T
    }
}

async function prepareUpdateIntent<T extends Types.Entity>(args: {
    runtime: CoreRuntime
    handle: StoreHandle<T>
    id: EntityId
    recipe: (draft: Draft<T>) => void
    opContext: Types.OperationContext
    options?: Types.StoreOperationOptions
}): Promise<{ intent: Types.WriteIntent<T>; output: T; base: Types.PartialWithId<T> }> {
    const base = await resolveBaseForWrite(args.runtime, args.handle, args.id, args.options)
    const next = produce(base as any, (draft: Draft<T>) => args.recipe(draft)) as any
    const patched = { ...(next as any), id: args.id } as Types.PartialWithId<T>
    const prepared = await prepareForUpdate(args.runtime, args.handle, base, patched, args.opContext)
    const baseVersion = version.requireBaseVersion(args.id, base as any)
    return {
        intent: {
            action: 'update',
            entityId: args.id,
            baseVersion,
            value: prepared as T
        },
        output: prepared as T,
        base
    }
}

async function prepareUpsertIntent<T extends Types.Entity>(args: {
    runtime: CoreRuntime
    handle: StoreHandle<T>
    item: Types.PartialWithId<T>
    opContext: Types.OperationContext
    options?: Types.StoreOperationOptions & Types.UpsertWriteOptions
}): Promise<{ intent: Types.WriteIntent<T>; output: T; afterSaveAction: 'add' | 'update'; base?: Types.PartialWithId<T> }> {
    const id = args.item.id
    const base = args.handle.jotaiStore.get(args.handle.atom).get(id) as Types.PartialWithId<T> | undefined
    const merge = args.options?.merge !== false

    const prepared = await (async () => {
        if (!base) {
            return await prepareForAdd(args.runtime, args.handle, args.item as any, args.opContext)
        }

        if (merge) {
            return await prepareForUpdate(args.runtime, args.handle, base, args.item, args.opContext)
        }

        const now = Date.now()
        const createdAt = (base as any).createdAt ?? now
        const candidate: any = {
            ...(args.item as any),
            id,
            createdAt,
            updatedAt: now
        }

        if (candidate.version === undefined && typeof (base as any).version === 'number') {
            candidate.version = (base as any).version
        }
        if (candidate._etag === undefined && typeof (base as any)._etag === 'string') {
            candidate._etag = (base as any)._etag
        }

        let next = await runBeforeSave(args.handle.hooks, candidate as any, 'update')
        const processed = await args.runtime.transform.inbound(args.handle, next as any, args.opContext)
        if (!processed) {
            throw new Error('[Atoma] upsertOne: transform returned empty')
        }
        return processed as Types.PartialWithId<T>
    })()

    const baseVersion = version.resolvePositiveVersion(prepared as any)
    const intentOptions = buildUpsertIntentOptions(args.options)
    const intent: Types.WriteIntent<T> = {
        action: 'upsert',
        entityId: id,
        ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
        value: prepared as T,
        ...(intentOptions ? { options: intentOptions } : {})
    }
    return {
        intent,
        output: prepared as T,
        afterSaveAction: base ? 'update' : 'add',
        base
    }
}

async function prepareDeleteIntent<T extends Types.Entity>(args: {
    runtime: CoreRuntime
    handle: StoreHandle<T>
    id: EntityId
    opContext: Types.OperationContext
    options?: Types.StoreOperationOptions
}): Promise<{ intent: Types.WriteIntent<T>; base: Types.PartialWithId<T> }> {
    const base = await resolveBaseForWrite(args.runtime, args.handle, args.id, args.options)
    const baseVersion = version.requireBaseVersion(args.id, base as any)
    if (args.options?.force) {
        return {
            intent: {
                action: 'delete',
                entityId: args.id,
                baseVersion
            },
            base
        }
    }
    return {
        intent: {
            action: 'update',
            entityId: args.id,
            baseVersion,
            value: Object.assign({}, base, { deleted: true, deletedAt: Date.now() }) as T
        },
        base
    }
}

 

export class WriteFlow implements RuntimeWrite {
    private runtime: CoreRuntime

    constructor(runtime: CoreRuntime) {
        this.runtime = runtime
    }

    addOne = async <T extends Types.Entity>(handle: StoreHandle<T>, item: Partial<T>, options?: Types.StoreOperationOptions): Promise<T> => {
        const runtime = this.runtime
        const opContext = ensureActionId(options?.opContext)
        const { intent, output } = await prepareAddIntent({ runtime, handle, item, opContext })
        const intents = [intent]

        const hooks = runtime.hooks
        hooks.emit.writeStart({ handle, opContext, intents, source: 'addOne' })

        const patchPayload = (() => {
            if (!hooks.has.writePatches) return null
            const entityId = intent.entityId as EntityId | undefined
            if (!entityId) return null
            const before = handle.jotaiStore.get(handle.atom).get(entityId) as T | undefined
            return buildRootPatches<T>({
                id: entityId,
                before,
                after: output as T
            })
        })()

        try {
            const result = await this.executeWrite<T>({
                handle,
                opContext,
                writeStrategy: options?.writeStrategy ?? handle.defaultWriteStrategy,
                intents
            })

            if (patchPayload) {
                hooks.emit.writePatches({
                    handle,
                    opContext,
                    patches: patchPayload.patches,
                    inversePatches: patchPayload.inversePatches,
                    source: 'addOne'
                })
            }
            hooks.emit.writeCommitted({ handle, opContext, result: result ?? output })

            await runAfterSave(handle.hooks, output as any, 'add')
            return (result ?? output) as T
        } catch (error) {
            hooks.emit.writeFailed({ handle, opContext, error })
            throw error
        }
    }

    addMany = async <T extends Types.Entity>(handle: StoreHandle<T>, items: Array<Partial<T>>, options?: Types.StoreOperationOptions): Promise<T[]> => {
        const results: T[] = []
        for (const item of items) {
            results.push(await this.addOne(handle, item, options))
        }
        return results
    }

    updateOne = async <T extends Types.Entity>(handle: StoreHandle<T>, id: EntityId, recipe: (draft: ImmerDraft<T>) => void, options?: Types.StoreOperationOptions): Promise<T> => {
        const runtime = this.runtime
        const opContext = ensureActionId(options?.opContext)
        const { intent, output, base } = await prepareUpdateIntent({
            runtime,
            handle,
            id,
            recipe: recipe as any,
            opContext,
            options
        })
        const intents = [intent]

        const hooks = runtime.hooks
        hooks.emit.writeStart({ handle, opContext, intents, source: 'updateOne' })

        const patchPayload = hooks.has.writePatches
            ? buildRootPatches<T>({ id, before: base as T, after: output as T })
            : null

        try {
            const result = await this.executeWrite<T>({
                handle,
                opContext,
                writeStrategy: options?.writeStrategy ?? handle.defaultWriteStrategy,
                intents
            })

            if (patchPayload) {
                hooks.emit.writePatches({
                    handle,
                    opContext,
                    patches: patchPayload.patches,
                    inversePatches: patchPayload.inversePatches,
                    source: 'updateOne'
                })
            }
            hooks.emit.writeCommitted({ handle, opContext, result: result ?? output })

            await runAfterSave(handle.hooks, output as any, 'update')
            return (result ?? output) as T
        } catch (error) {
            hooks.emit.writeFailed({ handle, opContext, error })
            throw error
        }
    }

    updateMany = async <T extends Types.Entity>(handle: StoreHandle<T>, items: Array<{ id: EntityId; recipe: (draft: ImmerDraft<T>) => void }>, options?: Types.StoreOperationOptions): Promise<Types.WriteManyResult<T>> => {
        const results: Types.WriteManyResult<T> = new Array(items.length)

        for (let index = 0; index < items.length; index++) {
            const entry = items[index]
            try {
                const value = await this.updateOne(handle, entry.id, entry.recipe, options)
                results[index] = { index, ok: true, value }
            } catch (error) {
                results[index] = { index, ok: false, error }
            }
        }

        return results
    }

    upsertOne = async <T extends Types.Entity>(handle: StoreHandle<T>, item: Types.PartialWithId<T>, options?: Types.StoreOperationOptions & Types.UpsertWriteOptions): Promise<T> => {
        const runtime = this.runtime
        const opContext = ensureActionId(options?.opContext)
        const { intent, output, afterSaveAction, base } = await prepareUpsertIntent({
            runtime,
            handle,
            item,
            opContext,
            options
        })
        const intents = [intent]

        const hooks = runtime.hooks
        hooks.emit.writeStart({ handle, opContext, intents, source: 'upsertOne' })

        const patchPayload = (() => {
            if (!hooks.has.writePatches) return null
            const entityId = intent.entityId as EntityId | undefined
            if (!entityId) return null
            return buildRootPatches<T>({
                id: entityId,
                before: base as T | undefined,
                after: output as T
            })
        })()

        try {
            const result = await this.executeWrite<T>({
                handle,
                opContext,
                writeStrategy: options?.writeStrategy ?? handle.defaultWriteStrategy,
                intents
            })

            if (patchPayload) {
                hooks.emit.writePatches({
                    handle,
                    opContext,
                    patches: patchPayload.patches,
                    inversePatches: patchPayload.inversePatches,
                    source: 'upsertOne'
                })
            }
            hooks.emit.writeCommitted({ handle, opContext, result: result ?? output })

            await runAfterSave(handle.hooks, output as any, afterSaveAction)
            return (result ?? output) as T
        } catch (error) {
            hooks.emit.writeFailed({ handle, opContext, error })
            throw error
        }
    }

    upsertMany = async <T extends Types.Entity>(handle: StoreHandle<T>, items: Array<Types.PartialWithId<T>>, options?: Types.StoreOperationOptions & Types.UpsertWriteOptions): Promise<Types.WriteManyResult<T>> => {
        const results: Types.WriteManyResult<T> = new Array(items.length)
        for (let index = 0; index < items.length; index++) {
            const entry = items[index]
            try {
                const value = await this.upsertOne(handle, entry, options)
                results[index] = { index, ok: true, value }
            } catch (error) {
                results[index] = { index, ok: false, error }
            }
        }
        return results
    }

    deleteOne = async <T extends Types.Entity>(handle: StoreHandle<T>, id: EntityId, options?: Types.StoreOperationOptions): Promise<boolean> => {
        const runtime = this.runtime
        const opContext = ensureActionId(options?.opContext)
        const { intent, base } = await prepareDeleteIntent({
            runtime,
            handle,
            id,
            opContext,
            options
        })
        const intents = [intent]

        const hooks = runtime.hooks
        hooks.emit.writeStart({ handle, opContext, intents, source: 'deleteOne' })

        const patchPayload = hooks.has.writePatches
            ? buildRootPatches<T>({
                id,
                before: base as T,
                after: intent.value as T | undefined,
                remove: intent.action === 'delete'
            })
            : null

        try {
            await this.executeWrite<T>({
                handle,
                opContext,
                writeStrategy: options?.writeStrategy ?? handle.defaultWriteStrategy,
                intents
            })

            if (patchPayload) {
                hooks.emit.writePatches({
                    handle,
                    opContext,
                    patches: patchPayload.patches,
                    inversePatches: patchPayload.inversePatches,
                    source: 'deleteOne'
                })
            }
            hooks.emit.writeCommitted({ handle, opContext, result: true })
            return true
        } catch (error) {
            hooks.emit.writeFailed({ handle, opContext, error })
            throw error
        }
    }

    deleteMany = async <T extends Types.Entity>(handle: StoreHandle<T>, ids: EntityId[], options?: Types.StoreOperationOptions): Promise<Types.WriteManyResult<boolean>> => {
        const results: Types.WriteManyResult<boolean> = new Array(ids.length)
        for (let index = 0; index < ids.length; index++) {
            const id = ids[index]
            try {
                const value = await this.deleteOne(handle, id, options)
                results[index] = { index, ok: true, value }
            } catch (error) {
                results[index] = { index, ok: false, error }
            }
        }
        return results
    }

    patches = async <T extends Types.Entity>(handle: StoreHandle<T>, patches: Patch[], inversePatches: Patch[], options?: Types.StoreOperationOptions): Promise<void> => {
        const opContext = ensureActionId(options?.opContext)
        const before = handle.jotaiStore.get(handle.atom) as Map<EntityId, T>
        const intents = buildWriteIntentsFromPatches({
            baseState: before,
            patches,
            inversePatches
        })
        const hooks = this.runtime.hooks
        hooks.emit.writeStart({ handle, opContext, intents, source: 'patches' })

        const patchPayload = hooks.has.writePatches
            ? { patches, inversePatches }
            : null

        try {
            await this.executeWrite<T>({
                handle,
                opContext,
                writeStrategy: options?.writeStrategy ?? handle.defaultWriteStrategy,
                intents
            })

            if (patchPayload) {
                hooks.emit.writePatches({
                    handle,
                    opContext,
                    patches: patchPayload.patches,
                    inversePatches: patchPayload.inversePatches,
                    source: 'patches'
                })
            }
            hooks.emit.writeCommitted({ handle, opContext })
        } catch (error) {
            hooks.emit.writeFailed({ handle, opContext, error })
            throw error
        }
    }

    private executeWrite = async <T extends Types.Entity>(args: {
        handle: StoreHandle<T>
        opContext: Types.OperationContext
        writeStrategy?: string
        intents?: Array<Types.WriteIntent<T>>
    }): Promise<T | void> => {
        const intents = this.makeIntents(args)
        const optimistic = this.applyOptimistic({
            handle: args.handle,
            intents,
            writeStrategy: args.writeStrategy
        })
        return await this.persistAndFinalize({
            handle: args.handle,
            intents,
            opContext: args.opContext,
            writeStrategy: args.writeStrategy,
            ...optimistic
        })
    }

    private makeIntents<T extends Types.Entity>(args: { intents?: Array<Types.WriteIntent<T>> }): Array<Types.WriteIntent<T>> {
        return args.intents ?? []
    }

    private applyOptimistic<T extends Types.Entity>(args: {
        handle: StoreHandle<T>
        intents: Array<Types.WriteIntent<T>>
        writeStrategy?: string
    }): { before: Map<EntityId, T>; optimisticState: Map<EntityId, T>; changedIds: Set<EntityId> } {
        const { handle, intents, writeStrategy } = args
        const { jotaiStore, atom } = handle
        const before = jotaiStore.get(atom) as Map<EntityId, T>
        const writePolicy = this.runtime.persistence.resolveWritePolicy(writeStrategy)
        const shouldOptimistic = writePolicy.optimistic !== false
        const optimistic = (shouldOptimistic && intents.length)
            ? applyIntentsOptimistically(before, intents)
            : { optimisticState: before, changedIds: new Set<EntityId>() }
        const { optimisticState, changedIds } = optimistic

        if (optimisticState !== before && changedIds.size) {
            handle.stateWriter.commitMapUpdateDelta({
                before,
                after: optimisticState,
                changedIds
            })
        }

        return { before, optimisticState, changedIds }
    }

    private persistAndFinalize<T extends Types.Entity>(args: {
        handle: StoreHandle<T>
        intents: Array<Types.WriteIntent<T>>
        opContext: Types.OperationContext
        writeStrategy?: string
        before: Map<EntityId, T>
        optimisticState: Map<EntityId, T>
        changedIds: Set<EntityId>
    }): Promise<T | void> {
        const runtime = this.runtime
        const { handle, intents, opContext } = args

        return (async () => {
            const writeOps = await buildWriteOps({
                runtime,
                handle,
                intents,
                opContext
            })

            if (!writeOps.length) {
                const primary = intents.length === 1 ? intents[0] : undefined
                if (primary && primary.action !== 'delete') {
                    return primary.value as T
                }
                return undefined
            }

            try {
                const persistResult = await runtime.persistence.persist({
                    storeName: String(handle.storeName),
                    writeStrategy: args.writeStrategy,
                    handle,
                    opContext,
                    writeOps
                })

                const primaryIntent = intents.length === 1 ? intents[0] : undefined
                const normalizedAck = await applyPersistAck(runtime, handle, primaryIntent, persistResult)
                return resolveOutputFromAck(primaryIntent, normalizedAck, primaryIntent?.value as T | undefined)
            } catch (error) {
                if (args.optimisticState !== args.before && args.changedIds.size) {
                    handle.stateWriter.commitMapUpdateDelta({
                        before: args.optimisticState,
                        after: args.before,
                        changedIds: args.changedIds
                    })
                }
                throw error
            }
        })()
    }
}
