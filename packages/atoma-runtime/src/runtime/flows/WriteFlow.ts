import { applyPatches, type Draft as ImmerDraft, type Patch } from 'immer'
import { version } from 'atoma-shared'
import type {
    Entity,
    OperationContext,
    PartialWithId,
    StoreOperationOptions,
    UpsertWriteOptions,
    WriteIntent,
    WriteManyItemErr,
    WriteManyItemOk,
    WriteManyResult
} from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import type { CoreRuntime, RuntimeWrite, RuntimeWriteHookSource, StoreHandle } from 'atoma-types/runtime'
import { WriteCommitFlow } from './write/commit/WriteCommitFlow'
import { WriteIntentFactory } from './write/services/WriteIntentFactory'
import { runAfterSave } from './write/utils/prepareWriteInput'

type WritePatchPayload = { patches: Patch[]; inversePatches: Patch[] } | null

type WriteContext = {
    opContext: OperationContext
    writeStrategy?: string
}

type GroupedWriteArgs<T extends Entity> = {
    handle: StoreHandle<T>
    context: WriteContext
    intents: Array<WriteIntent<T>>
    source: RuntimeWriteHookSource
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

function buildWriteIntentsFromPatches<T extends Entity>(args: {
    baseState: Map<EntityId, T>
    patches: Patch[]
    inversePatches: Patch[]
}): WriteIntent<T>[] {
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
        baseVersionByDeletedId.set(id, version.requireBaseVersion(id, value))
    })

    const intents: WriteIntent<T>[] = []
    for (const id of touchedIds.values()) {
        const next = optimisticState.get(id)

        if (next) {
            const baseVersion = version.resolvePositiveVersion(next)
            intents.push({
                action: 'upsert',
                entityId: id,
                ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
                value: next,
                options: { merge: false, upsert: { mode: 'loose' } }
            })
            continue
        }

        const baseVersion = baseVersionByDeletedId.get(id)
        if (!(typeof baseVersion === 'number' && Number.isFinite(baseVersion) && baseVersion > 0)) {
            throw new Error(`[Atoma] restore/replace delete requires baseVersion (id=${String(id)})`)
        }

        intents.push({
            action: 'delete',
            entityId: id,
            baseVersion
        })
    }

    return intents
}

export class WriteFlow implements RuntimeWrite {
    private readonly runtime: CoreRuntime
    private readonly writeCommitFlow: WriteCommitFlow
    private readonly writeIntentFactory: WriteIntentFactory

    constructor(runtime: CoreRuntime) {
        this.runtime = runtime
        this.writeCommitFlow = new WriteCommitFlow()
        this.writeIntentFactory = new WriteIntentFactory(runtime)
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
        intents: Array<WriteIntent<T>>
        source: RuntimeWriteHookSource
        output?: T
        patchPayload: WritePatchPayload
        afterSaveAction?: 'add' | 'update'
    }): Promise<T | void> => {
        const { handle, opContext, intents, source, patchPayload } = args
        const hooks = this.runtime.hooks

        hooks.emit.writeStart({ handle, opContext, intents, source })

        try {
            const committed = await this.writeCommitFlow.execute<T>({
                runtime: this.runtime,
                handle,
                opContext,
                writeStrategy: args.writeStrategy,
                intents
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
        intent: WriteIntent<T>
        source: RuntimeWriteHookSource
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
            intents: [args.intent],
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
            intents: args.intents,
            source: args.source,
            patchPayload: args.patchPayload,
            output: args.output,
            afterSaveAction: args.afterSaveAction
        })
    }

    addOne = async <T extends Entity>(handle: StoreHandle<T>, item: Partial<T>, options?: StoreOperationOptions): Promise<T> => {
        const context = this.buildWriteContext(handle, options)
        const { intent, output } = await this.writeIntentFactory.prepareAddIntent<T>({
            handle,
            item,
            opContext: context.opContext
        })

        const entityId = intent.entityId
        const before = entityId !== undefined
            ? handle.state.getSnapshot().get(entityId)
            : undefined

        const committed = await this.commitEntityWrite({
            handle,
            id: entityId,
            before,
            after: output,
            context,
            intent,
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
        const { intent, output, base } = await this.writeIntentFactory.prepareUpdateIntent<T>({
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
            intent,
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
        const { intent, output, afterSaveAction, base } = await this.writeIntentFactory.prepareUpsertIntent<T>({
            handle,
            item,
            opContext: context.opContext,
            options
        })

        const committed = await this.commitEntityWrite({
            handle,
            id: intent.entityId,
            before: base as T | undefined,
            after: output,
            context,
            intent,
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
        const { intent, base } = await this.writeIntentFactory.prepareDeleteIntent<T>({
            handle,
            id,
            options
        })

        await this.commitEntityWrite({
            handle,
            id,
            before: base as T,
            after: intent.value,
            remove: intent.action === 'delete',
            context,
            intent,
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
        const intents = buildWriteIntentsFromPatches({
            baseState: before,
            patches,
            inversePatches
        })

        await this.commitGroupedWrite({
            handle,
            context,
            intents,
            source: 'patches',
            patchPayload: this.buildRawPatchPayload(patches, inversePatches)
        })
    }
}
