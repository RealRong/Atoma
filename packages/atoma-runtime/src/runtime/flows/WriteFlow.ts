import { applyPatches, type Draft as ImmerDraft, type Patch } from 'immer'
import { requireBaseVersion, resolvePositiveVersion } from 'atoma-shared'
import type {
    Entity,
    OperationContext,
    PartialWithId,
    StoreOperationOptions,
    UpsertWriteOptions,
    WriteManyItemErr,
    WriteManyItemOk,
    WriteManyResult
} from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { createIdempotencyKey, ensureWriteItemMeta } from 'atoma-types/protocol-tools'
import type { Runtime, Write, WriteHookSource, StoreHandle } from 'atoma-types/runtime'
import { WriteCommitFlow } from './write/commit/WriteCommitFlow'
import type { PersistPlan, PersistPlanEntry } from './write/types'
import { WriteEntryFactory } from './write/services/WriteEntryFactory'
import { runAfterSave } from './write/utils/prepareWriteInput'

type WritePatchPayload = { patches: Patch[]; inversePatches: Patch[] } | null

type WriteContext = {
    opContext: OperationContext
    writeStrategy?: string
}

type GroupedWriteArgs<T extends Entity> = {
    handle: StoreHandle<T>
    context: WriteContext
    plan: PersistPlan<T>
    source: WriteHookSource
    patchPayload: WritePatchPayload
    output?: T
    afterSaveAction?: 'add' | 'update'
}

function collectInverseRootAdds(inversePatches: Patch[]): Map<EntityId, unknown> {
    const out = new Map<EntityId, unknown>()
    if (!Array.isArray(inversePatches)) return out

    for (const patch of inversePatches) {
        if ((patch as any)?.op !== 'add') continue
        const path = (patch as any)?.path
        if (!Array.isArray(path) || path.length !== 1) continue

        const root = path[0]
        if (typeof root !== 'string' && typeof root !== 'number') continue
        out.set(String(root), (patch as any).value)
    }

    return out
}

function buildWritePlanFromPatches<T extends Entity>(args: {
    baseState: Map<EntityId, T>
    patches: Patch[]
    inversePatches: Patch[]
    now: () => number
    createEntryId: () => string
}): PersistPlan<T> {
    const optimisticState = applyPatches(args.baseState, args.patches) as Map<EntityId, T>
    const touchedIds = new Set<EntityId>()

    for (const patch of args.patches) {
        const root = patch.path?.[0]
        if (typeof root === 'string' || typeof root === 'number') {
            const id = String(root)
            if (id.length > 0) {
                touchedIds.add(id)
            }
        }
    }

    const inverseRootAdds = collectInverseRootAdds(args.inversePatches)
    const baseVersionByDeletedId = new Map<EntityId, number>()
    inverseRootAdds.forEach((value, id) => {
        baseVersionByDeletedId.set(id, requireBaseVersion(id, value))
    })

    const plan: PersistPlanEntry<T>[] = []
    for (const id of touchedIds.values()) {
        const writeItemMeta = ensureWriteItemMeta({
            meta: {
                idempotencyKey: createIdempotencyKey({ now: args.now }),
                clientTimeMs: args.now()
            },
            now: args.now
        })

        const next = optimisticState.get(id)
        if (next) {
            const baseVersion = resolvePositiveVersion(next)
            plan.push({
                entry: {
                    entryId: args.createEntryId(),
                    action: 'upsert',
                    item: {
                        entityId: id,
                        ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
                        value: next,
                        meta: writeItemMeta
                    },
                    options: { merge: false, upsert: { mode: 'loose' } }
                },
                optimistic: {
                    action: 'upsert',
                    entityId: id,
                    value: next
                }
            })
            continue
        }

        const baseVersion = baseVersionByDeletedId.get(id)
        if (!(typeof baseVersion === 'number' && Number.isFinite(baseVersion) && baseVersion > 0)) {
            throw new Error(`[Atoma] restore/replace delete requires baseVersion (id=${String(id)})`)
        }

        plan.push({
            entry: {
                entryId: args.createEntryId(),
                action: 'delete',
                item: {
                    entityId: id,
                    baseVersion,
                    meta: writeItemMeta
                }
            },
            optimistic: {
                action: 'delete',
                entityId: id
            }
        })
    }

    return plan
}

export class WriteFlow implements Write {
    private readonly runtime: Runtime
    private readonly writeCommitFlow: WriteCommitFlow
    private readonly writeEntryFactory: WriteEntryFactory

    constructor(runtime: Runtime) {
        this.runtime = runtime
        this.writeCommitFlow = new WriteCommitFlow()
        this.writeEntryFactory = new WriteEntryFactory(runtime)
    }

    private buildWriteContext = (handle: StoreHandle<any>, options?: StoreOperationOptions): WriteContext => {
        return {
            opContext: this.runtime.engine.operation.createContext(options?.opContext),
            writeStrategy: options?.writeStrategy ?? handle.config.defaultWriteStrategy
        }
    }

    private shouldEmitWritePatches = (): boolean => {
        return this.runtime.hooks.has.event('writePatches')
    }

    private buildEntityPatchPayload = <T extends Entity>(args: {
        id?: EntityId
        before?: T
        after?: T
        remove?: boolean
    }): WritePatchPayload => {
        if (!this.shouldEmitWritePatches()) return null
        if (!args.id) return null

        const path: Patch['path'] = [args.id as string | number]
        const hasBefore = args.before !== undefined
        const hasAfter = args.after !== undefined

        if (args.remove) {
            const patches: Patch[] = [{ op: 'remove', path }]
            const inversePatches: Patch[] = hasBefore
                ? [{ op: 'add', path, value: args.before }]
                : []
            return { patches, inversePatches }
        }

        if (!hasAfter) {
            return { patches: [], inversePatches: [] }
        }

        if (hasBefore) {
            return {
                patches: [{ op: 'replace', path, value: args.after }],
                inversePatches: [{ op: 'replace', path, value: args.before }]
            }
        }

        return {
            patches: [{ op: 'add', path, value: args.after }],
            inversePatches: [{ op: 'remove', path }]
        }
    }

    private buildRawPatchPayload = (patches: Patch[], inversePatches: Patch[]): WritePatchPayload => {
        if (!this.shouldEmitWritePatches()) return null
        return { patches, inversePatches }
    }

    private executeBatch = async <Input, Output>(args: {
        items: Input[]
        options?: StoreOperationOptions
        runner: (item: Input) => Promise<Output>
    }): Promise<WriteManyResult<Output>> => {
        const { items, runner } = args
        const rawConcurrency = args.options?.batch?.concurrency
        const concurrency = (typeof rawConcurrency === 'number' && Number.isFinite(rawConcurrency))
            ? Math.max(1, Math.floor(rawConcurrency))
            : 1

        const results: WriteManyResult<Output> = new Array(items.length)
        if (!items.length) return results

        const onSuccess = (index: number, value: Output): WriteManyItemOk<Output> => ({ index, ok: true, value })
        const onError = (index: number, error: unknown): WriteManyItemErr => ({ index, ok: false, error })

        if (concurrency <= 1 || items.length <= 1) {
            for (let index = 0; index < items.length; index++) {
                try {
                    const value = await runner(items[index])
                    results[index] = onSuccess(index, value)
                } catch (error) {
                    results[index] = onError(index, error)
                }
            }
            return results
        }

        let cursor = 0
        const worker = async () => {
            while (true) {
                const index = cursor
                cursor += 1
                if (index >= items.length) return

                try {
                    const value = await runner(items[index])
                    results[index] = onSuccess(index, value)
                } catch (error) {
                    results[index] = onError(index, error)
                }
            }
        }

        const workerCount = Math.min(concurrency, items.length)
        await Promise.all(new Array(workerCount).fill(null).map(() => worker()))
        return results
    }

    private executeBatchOrThrow = async <Input, Output>(args: {
        items: Input[]
        options?: StoreOperationOptions
        runner: (item: Input) => Promise<Output>
    }): Promise<Output[]> => {
        const results = await this.executeBatch(args)
        const values: Output[] = []

        for (const result of results) {
            if (!result.ok) {
                throw result.error
            }
            values.push(result.value)
        }

        return values
    }

    private commitWrite = async <T extends Entity>(args: {
        handle: StoreHandle<T>
        opContext: OperationContext
        writeStrategy?: string
        plan: PersistPlan<T>
        source: WriteHookSource
        output?: T
        patchPayload: WritePatchPayload
        afterSaveAction?: 'add' | 'update'
    }): Promise<T | void> => {
        const { handle, opContext, plan, source, patchPayload } = args
        const hooks = this.runtime.hooks

        hooks.emit.writeStart({
            handle,
            opContext,
            entries: plan.map(entry => entry.entry),
            source
        })

        try {
            const committed = await this.writeCommitFlow.execute<T>({
                runtime: this.runtime,
                handle,
                opContext,
                writeStrategy: args.writeStrategy,
                plan
            })

            if (patchPayload) {
                hooks.emit.writePatches({
                    handle,
                    opContext,
                    patches: patchPayload.patches,
                    inversePatches: patchPayload.inversePatches,
                    source
                })
            }

            const finalValue = committed ?? args.output
            hooks.emit.writeCommitted({ handle, opContext, result: finalValue })

            if (args.afterSaveAction && args.output) {
                await runAfterSave(handle.config.hooks, args.output, args.afterSaveAction)
            }

            return finalValue
        } catch (error) {
            hooks.emit.writeFailed({ handle, opContext, error })
            throw error
        }
    }

    private commitEntityWrite = async <T extends Entity>(args: {
        handle: StoreHandle<T>
        context: WriteContext
        planEntry: PersistPlanEntry<T>
        source: WriteHookSource
        id?: EntityId
        before?: T
        after?: T
        remove?: boolean
        output?: T
        afterSaveAction?: 'add' | 'update'
    }): Promise<T | void> => {
        const patchPayload = this.buildEntityPatchPayload<T>({
            id: args.id,
            before: args.before,
            after: args.after,
            remove: args.remove
        })

        return await this.commitWrite({
            handle: args.handle,
            ...args.context,
            plan: [args.planEntry],
            source: args.source,
            patchPayload,
            output: args.output,
            afterSaveAction: args.afterSaveAction
        })
    }

    private commitGroupedWrite = async <T extends Entity>(args: GroupedWriteArgs<T>): Promise<T | void> => {
        return await this.commitWrite({
            handle: args.handle,
            ...args.context,
            plan: args.plan,
            source: args.source,
            patchPayload: args.patchPayload,
            output: args.output,
            afterSaveAction: args.afterSaveAction
        })
    }

    addOne = async <T extends Entity>(handle: StoreHandle<T>, item: Partial<T>, options?: StoreOperationOptions): Promise<T> => {
        const context = this.buildWriteContext(handle, options)
        const { planEntry, output } = await this.writeEntryFactory.prepareAddEntry<T>({
            handle,
            item,
            opContext: context.opContext
        })

        const entityId = planEntry.optimistic.entityId
        const before = entityId !== undefined
            ? handle.state.getSnapshot().get(entityId)
            : undefined

        const committed = await this.commitEntityWrite({
            handle,
            id: entityId,
            before,
            after: output,
            context,
            planEntry,
            source: 'addOne',
            output,
            afterSaveAction: 'add'
        })

        return (committed ?? output) as T
    }

    addMany = async <T extends Entity>(handle: StoreHandle<T>, items: Array<Partial<T>>, options?: StoreOperationOptions): Promise<T[]> => {
        return await this.executeBatchOrThrow({
            items,
            options,
            runner: (entry) => this.addOne(handle, entry, options)
        })
    }

    updateOne = async <T extends Entity>(handle: StoreHandle<T>, id: EntityId, recipe: (draft: ImmerDraft<T>) => void, options?: StoreOperationOptions): Promise<T> => {
        const context = this.buildWriteContext(handle, options)
        const { planEntry, output, base } = await this.writeEntryFactory.prepareUpdateEntry<T>({
            handle,
            id,
            recipe,
            opContext: context.opContext,
            options
        })

        const committed = await this.commitEntityWrite({
            handle,
            id,
            before: base as T,
            after: output,
            context,
            planEntry,
            source: 'updateOne',
            output,
            afterSaveAction: 'update'
        })

        return (committed ?? output) as T
    }

    updateMany = async <T extends Entity>(
        handle: StoreHandle<T>,
        items: Array<{ id: EntityId; recipe: (draft: ImmerDraft<T>) => void }>,
        options?: StoreOperationOptions
    ): Promise<WriteManyResult<T>> => {
        return await this.executeBatch({
            items,
            options,
            runner: (entry) => this.updateOne(handle, entry.id, entry.recipe, options)
        })
    }

    upsertOne = async <T extends Entity>(handle: StoreHandle<T>, item: PartialWithId<T>, options?: StoreOperationOptions & UpsertWriteOptions): Promise<T> => {
        const context = this.buildWriteContext(handle, options)
        const { planEntry, output, afterSaveAction, base } = await this.writeEntryFactory.prepareUpsertEntry<T>({
            handle,
            item,
            opContext: context.opContext,
            options
        })

        const committed = await this.commitEntityWrite({
            handle,
            id: planEntry.optimistic.entityId,
            before: base as T | undefined,
            after: output,
            context,
            planEntry,
            source: 'upsertOne',
            output,
            afterSaveAction
        })

        return (committed ?? output) as T
    }

    upsertMany = async <T extends Entity>(handle: StoreHandle<T>, items: Array<PartialWithId<T>>, options?: StoreOperationOptions & UpsertWriteOptions): Promise<WriteManyResult<T>> => {
        return await this.executeBatch({
            items,
            options,
            runner: (entry) => this.upsertOne(handle, entry, options)
        })
    }

    deleteOne = async <T extends Entity>(handle: StoreHandle<T>, id: EntityId, options?: StoreOperationOptions): Promise<boolean> => {
        const context = this.buildWriteContext(handle, options)
        const { planEntry, base } = await this.writeEntryFactory.prepareDeleteEntry<T>({
            handle,
            id,
            opContext: context.opContext,
            options
        })

        await this.commitEntityWrite({
            handle,
            id,
            before: base as T,
            after: planEntry.optimistic.value,
            remove: planEntry.entry.action === 'delete',
            context,
            planEntry,
            source: 'deleteOne'
        })

        return true
    }

    deleteMany = async <T extends Entity>(handle: StoreHandle<T>, ids: EntityId[], options?: StoreOperationOptions): Promise<WriteManyResult<boolean>> => {
        return await this.executeBatch({
            items: ids,
            options,
            runner: (idValue) => this.deleteOne(handle, idValue, options)
        })
    }

    patches = async <T extends Entity>(
        handle: StoreHandle<T>,
        patches: Patch[],
        inversePatches: Patch[],
        options?: StoreOperationOptions
    ): Promise<void> => {
        const context = this.buildWriteContext(handle, options)
        const before = handle.state.getSnapshot() as Map<EntityId, T>
        const plan = buildWritePlanFromPatches({
            baseState: before,
            patches,
            inversePatches,
            now: this.runtime.now,
            createEntryId: () => this.runtime.nextOpId(handle.storeName, 'w')
        })

        await this.commitGroupedWrite({
            handle,
            context,
            plan,
            source: 'patches',
            patchPayload: this.buildRawPatchPayload(patches, inversePatches)
        })
    }
}
