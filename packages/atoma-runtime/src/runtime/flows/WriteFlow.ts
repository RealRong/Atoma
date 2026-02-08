import type { Draft as ImmerDraft, Patch } from 'immer'
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
import { buildWriteIntentsFromPatches } from './write/commit/buildWriteIntentsFromPatches'
import { ensureActionId, runAfterSave } from './write/utils/prepareWriteInput'
import { buildEntityRootPatches } from './write/utils/buildEntityRootPatches'
import { runWriteBatch } from './write/utils/runWriteBatch'
import { WriteIntentFactory } from './write/services/WriteIntentFactory'
import { WriteCommitFlow } from './write/commit/WriteCommitFlow'

type WritePatchPayload = { patches: Patch[]; inversePatches: Patch[] } | null

type WriteContext = {
    opContext: OperationContext
    writeStrategy?: string
}

type PreparedWriteArgs<T extends Entity> = {
    handle: StoreHandle<T>
    context: WriteContext
    intents: Array<WriteIntent<T>>
    source: RuntimeWriteHookSource
    patchPayload: WritePatchPayload
    output?: T
    afterSaveAction?: 'add' | 'update'
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

    private resolveWriteContext = <T extends Entity>(handle: StoreHandle<T>, options?: StoreOperationOptions): WriteContext => {
        return {
            opContext: ensureActionId(this.runtime, options?.opContext),
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

        return buildEntityRootPatches<T>({
            id: args.id,
            before: args.before,
            after: args.after,
            remove: args.remove
        })
    }

    private buildRawPatchPayload = (patches: Patch[], inversePatches: Patch[]): WritePatchPayload => {
        if (!this.shouldEmitWritePatches()) return null
        return { patches, inversePatches }
    }

    private runMany = async <Input, Output>(args: {
        items: Input[]
        options?: StoreOperationOptions
        runner: (item: Input) => Promise<Output>
    }): Promise<WriteManyResult<Output>> => {
        return await runWriteBatch<Input, Output, WriteManyItemOk<Output> | WriteManyItemErr>({
            items: args.items,
            options: args.options,
            runner: args.runner,
            onSuccess: ({ index, value }) => ({ index, ok: true, value }),
            onError: ({ index, error }) => ({ index, ok: false, error })
        })
    }

    private runManyOrThrow = async <Input, Output>(args: {
        items: Input[]
        options?: StoreOperationOptions
        runner: (item: Input) => Promise<Output>
    }): Promise<Output[]> => {
        const results = await this.runMany(args)
        const values: Output[] = []

        for (const result of results) {
            if (!result.ok) {
                throw result.error
            }
            values.push(result.value)
        }

        return values
    }

    private executeSingleWrite = async <T extends Entity>(args: {
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

    private executePreparedWrite = async <T extends Entity>(args: PreparedWriteArgs<T>): Promise<T | void> => {
        return await this.executeSingleWrite({
            handle: args.handle,
            ...args.context,
            intents: args.intents,
            source: args.source,
            output: args.output,
            patchPayload: args.patchPayload,
            afterSaveAction: args.afterSaveAction
        })
    }

    private executeEntityWrite = async <T extends Entity>(args: {
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

        return await this.executePreparedWrite({
            handle: args.handle,
            context: args.context,
            intents: [args.intent],
            source: args.source,
            patchPayload,
            output: args.output,
            afterSaveAction: args.afterSaveAction
        })
    }

    addOne = async <T extends Entity>(handle: StoreHandle<T>, item: Partial<T>, options?: StoreOperationOptions): Promise<T> => {
        const context = this.resolveWriteContext(handle, options)
        const { intent, output } = await this.writeIntentFactory.prepareAddIntent<T>({
            handle,
            item,
            opContext: context.opContext
        })

        const entityId = intent.entityId
        const before = entityId !== undefined
            ? handle.state.getSnapshot().get(entityId)
            : undefined

        const committed = await this.executeEntityWrite({
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
        return await this.runManyOrThrow({
            items,
            options,
            runner: (entry) => this.addOne(handle, entry, options)
        })
    }

    updateOne = async <T extends Entity>(handle: StoreHandle<T>, id: EntityId, recipe: (draft: ImmerDraft<T>) => void, options?: StoreOperationOptions): Promise<T> => {
        const context = this.resolveWriteContext(handle, options)
        const { intent, output, base } = await this.writeIntentFactory.prepareUpdateIntent<T>({
            handle,
            id,
            recipe,
            opContext: context.opContext,
            options
        })

        const committed = await this.executeEntityWrite({
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

    updateMany = async <T extends Entity>(handle: StoreHandle<T>, items: Array<{ id: EntityId; recipe: (draft: ImmerDraft<T>) => void }>, options?: StoreOperationOptions): Promise<WriteManyResult<T>> => {
        return await this.runMany({
            items,
            options,
            runner: (entry) => this.updateOne(handle, entry.id, entry.recipe, options)
        })
    }

    upsertOne = async <T extends Entity>(handle: StoreHandle<T>, item: PartialWithId<T>, options?: StoreOperationOptions & UpsertWriteOptions): Promise<T> => {
        const context = this.resolveWriteContext(handle, options)
        const { intent, output, afterSaveAction, base } = await this.writeIntentFactory.prepareUpsertIntent<T>({
            handle,
            item,
            opContext: context.opContext,
            options
        })

        const committed = await this.executeEntityWrite({
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
        return await this.runMany({
            items,
            options,
            runner: (entry) => this.upsertOne(handle, entry, options)
        })
    }

    deleteOne = async <T extends Entity>(handle: StoreHandle<T>, id: EntityId, options?: StoreOperationOptions): Promise<boolean> => {
        const context = this.resolveWriteContext(handle, options)
        const { intent, base } = await this.writeIntentFactory.prepareDeleteIntent<T>({
            handle,
            id,
            opContext: context.opContext,
            options
        })

        await this.executeEntityWrite({
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
        return await this.runMany({
            items: ids,
            options,
            runner: (idValue) => this.deleteOne(handle, idValue, options)
        })
    }

    patches = async <T extends Entity>(handle: StoreHandle<T>, patches: Patch[], inversePatches: Patch[], options?: StoreOperationOptions): Promise<void> => {
        const context = this.resolveWriteContext(handle, options)
        const before = handle.state.getSnapshot() as Map<EntityId, T>
        const intents = buildWriteIntentsFromPatches({
            baseState: before,
            patches,
            inversePatches
        })

        await this.executePreparedWrite({
            handle,
            context,
            intents,
            source: 'patches',
            patchPayload: this.buildRawPatchPayload(patches, inversePatches)
        })
    }
}
