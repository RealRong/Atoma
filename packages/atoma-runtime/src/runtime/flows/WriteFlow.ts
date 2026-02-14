import { type Draft as ImmerDraft, type Patch } from 'immer'
import type {
    Entity,
    OperationContext,
    PartialWithId,
    StoreOperationOptions,
    UpsertWriteOptions,
    WriteRoute,
    WriteManyResult
} from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import type { Runtime, Write, WriteHookSource, StoreHandle } from 'atoma-types/runtime'
import { WriteCommitFlow } from './write/commit/WriteCommitFlow'
import { WriteEntryFactory } from './write/services/WriteEntryFactory'
import type { WritePlan, WritePlanEntry } from './write/types'
import { runBatch, runBatchOrThrow } from './write/utils/batch'
import { buildPatchWritePlan } from './write/utils/patchPlan'
import { buildEntityPatchPayload, buildRawPatchPayload, type WritePatchPayload } from './write/utils/patchPayload'
import { runAfterSave } from './write/utils/prepareWriteInput'

type WriteContext = {
    opContext: OperationContext
    route?: WriteRoute
}

function createWriteContext<T extends Entity>(
    runtime: Runtime,
    handle: StoreHandle<T>,
    options?: StoreOperationOptions
): WriteContext {
    return {
        opContext: runtime.engine.operation.createContext(options?.opContext),
        route: options?.route ?? handle.config.defaultRoute
    }
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

    private shouldEmitWritePatches = (): boolean => {
        return this.runtime.hooks.has.event('writePatches')
    }

    private commitWrite = async <T extends Entity>(args: {
        handle: StoreHandle<T>
        opContext: OperationContext
        route?: WriteRoute
        plan: WritePlan<T>
        source: WriteHookSource
        output?: T
        patchPayload: WritePatchPayload
        afterSaveAction?: 'add' | 'update'
    }): Promise<T | void> => {
        const { handle, opContext, plan, source, patchPayload } = args
        const hooks = this.runtime.hooks
        const writeEntries = plan.map(planEntry => planEntry.entry)

        hooks.emit.writeStart({
            handle,
            opContext,
            entryCount: plan.length,
            source,
            route: args.route,
            writeEntries
        })

        try {
            const committed = await this.writeCommitFlow.execute<T>({
                runtime: this.runtime,
                handle,
                opContext,
                route: args.route,
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
            hooks.emit.writeCommitted({
                handle,
                opContext,
                route: args.route,
                writeEntries,
                result: finalValue
            })

            if (args.afterSaveAction && args.output) {
                await runAfterSave(handle.config.hooks, args.output, args.afterSaveAction)
            }

            return finalValue
        } catch (error) {
            hooks.emit.writeFailed({
                handle,
                opContext,
                route: args.route,
                writeEntries,
                error
            })
            throw error
        }
    }

    private commitEntityWrite = async <T extends Entity>(args: {
        handle: StoreHandle<T>
        context: WriteContext
        planEntry: WritePlanEntry<T>
        source: WriteHookSource
        id?: EntityId
        before?: T
        after?: T
        remove?: boolean
        output?: T
        afterSaveAction?: 'add' | 'update'
    }): Promise<T | void> => {
        const patchPayload = buildEntityPatchPayload({
            enabled: this.shouldEmitWritePatches(),
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

    addOne = async <T extends Entity>(handle: StoreHandle<T>, item: Partial<T>, options?: StoreOperationOptions): Promise<T> => {
        const context = createWriteContext(this.runtime, handle, options)
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
        return await runBatchOrThrow({
            items,
            options,
            runner: (entry) => this.addOne(handle, entry, options)
        })
    }

    updateOne = async <T extends Entity>(handle: StoreHandle<T>, id: EntityId, recipe: (draft: ImmerDraft<T>) => void, options?: StoreOperationOptions): Promise<T> => {
        const context = createWriteContext(this.runtime, handle, options)
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
        return await runBatch({
            items,
            options,
            runner: (entry) => this.updateOne(handle, entry.id, entry.recipe, options)
        })
    }

    upsertOne = async <T extends Entity>(handle: StoreHandle<T>, item: PartialWithId<T>, options?: StoreOperationOptions & UpsertWriteOptions): Promise<T> => {
        const context = createWriteContext(this.runtime, handle, options)
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
        return await runBatch({
            items,
            options,
            runner: (entry) => this.upsertOne(handle, entry, options)
        })
    }

    deleteOne = async <T extends Entity>(handle: StoreHandle<T>, id: EntityId, options?: StoreOperationOptions): Promise<boolean> => {
        const context = createWriteContext(this.runtime, handle, options)
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
        return await runBatch({
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
        const context = createWriteContext(this.runtime, handle, options)
        const before = handle.state.getSnapshot() as Map<EntityId, T>
        const plan = await buildPatchWritePlan({
            runtime: this.runtime,
            handle,
            opContext: context.opContext,
            baseState: before,
            patches,
            inversePatches,
            createEntryId: () => this.runtime.nextOpId(handle.storeName, 'w')
        })

        await this.commitWrite({
            handle,
            ...context,
            plan,
            source: 'patches',
            patchPayload: buildRawPatchPayload({
                enabled: this.shouldEmitWritePatches(),
                patches,
                inversePatches
            })
        })
    }
}
