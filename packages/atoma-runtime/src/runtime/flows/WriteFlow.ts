import type {
    ChangeDirection,
    Entity,
    OperationContext,
    PartialWithId,
    StoreChange,
    StoreOperationOptions,
    StoreUpdater,
    UpsertWriteOptions,
    ExecutionRoute,
    WriteManyResult
} from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import type { Runtime, Write, WriteEventSource, StoreHandle } from 'atoma-types/runtime'
import { WriteCommitFlow } from './write/commit/WriteCommitFlow'
import { WriteEntryFactory } from './write/services/WriteEntryFactory'
import type { WritePlan, WritePlanEntry } from './write/types'
import { runBatch, runBatchOrThrow } from './write/utils/batch'
import { buildChangeWritePlan } from './write/utils/changePlan'

type WriteContext = {
    opContext: OperationContext
    route?: ExecutionRoute
    signal?: AbortSignal
}

function createWriteContext<T extends Entity>(
    runtime: Runtime,
    handle: StoreHandle<T>,
    options?: StoreOperationOptions
): WriteContext {
    return {
        opContext: runtime.engine.operation.createContext(options?.opContext),
        route: options?.route ?? handle.config.defaultRoute,
        signal: options?.signal
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

    private commitWrite = async <T extends Entity>(args: {
        handle: StoreHandle<T>
        opContext: OperationContext
        route?: ExecutionRoute
        signal?: AbortSignal
        plan: WritePlan<T>
        source: WriteEventSource
        output?: T
    }): Promise<T | void> => {
        const { handle, opContext, plan, source } = args
        const events = this.runtime.events
        const writeEntries = plan.map(planEntry => planEntry.entry)

        events.emit.writeStart({
            handle,
            opContext,
            entryCount: plan.length,
            source,
            route: args.route,
            writeEntries
        })

        try {
            const commitResult = await this.writeCommitFlow.execute<T>({
                runtime: this.runtime,
                handle,
                opContext,
                route: args.route,
                signal: args.signal,
                plan,
            })

            const finalValue = commitResult.output ?? args.output
            events.emit.writeCommitted({
                handle,
                opContext,
                route: args.route,
                writeEntries,
                result: finalValue,
                changes: commitResult.changes
            })

            return finalValue
        } catch (error) {
            events.emit.writeFailed({
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
        source: WriteEventSource
        output?: T
    }): Promise<T | void> => {
        return await this.commitWrite({
            handle: args.handle,
            ...args.context,
            plan: [args.planEntry],
            source: args.source,
            output: args.output
        })
    }

    addOne = async <T extends Entity>(handle: StoreHandle<T>, item: Partial<T>, options?: StoreOperationOptions): Promise<T> => {
        const context = createWriteContext(this.runtime, handle, options)
        const { planEntry, output } = await this.writeEntryFactory.prepareAddEntry<T>({
            handle,
            item,
            opContext: context.opContext
        })

        const committed = await this.commitEntityWrite({
            handle,
            context,
            planEntry,
            source: 'addOne',
            output
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

    updateOne = async <T extends Entity>(handle: StoreHandle<T>, id: EntityId, updater: StoreUpdater<T>, options?: StoreOperationOptions): Promise<T> => {
        const context = createWriteContext(this.runtime, handle, options)
        const { planEntry, output } = await this.writeEntryFactory.prepareUpdateEntry<T>({
            handle,
            id,
            updater,
            opContext: context.opContext,
            options
        })

        const committed = await this.commitEntityWrite({
            handle,
            context,
            planEntry,
            source: 'updateOne',
            output
        })

        return (committed ?? output) as T
    }

    updateMany = async <T extends Entity>(
        handle: StoreHandle<T>,
        items: Array<{ id: EntityId; updater: StoreUpdater<T> }>,
        options?: StoreOperationOptions
    ): Promise<WriteManyResult<T>> => {
        return await runBatch({
            items,
            options,
            runner: (entry) => this.updateOne(handle, entry.id, entry.updater, options)
        })
    }

    upsertOne = async <T extends Entity>(handle: StoreHandle<T>, item: PartialWithId<T>, options?: StoreOperationOptions & UpsertWriteOptions): Promise<T> => {
        const context = createWriteContext(this.runtime, handle, options)
        const { planEntry, output } = await this.writeEntryFactory.prepareUpsertEntry<T>({
            handle,
            item,
            opContext: context.opContext,
            options
        })

        const committed = await this.commitEntityWrite({
            handle,
            context,
            planEntry,
            source: 'upsertOne',
            output
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
        const { planEntry } = await this.writeEntryFactory.prepareDeleteEntry<T>({
            handle,
            id,
            opContext: context.opContext,
            options
        })

        await this.commitEntityWrite({
            handle,
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

    applyChanges = async <T extends Entity>(
        handle: StoreHandle<T>,
        changes: ReadonlyArray<StoreChange<T>>,
        direction: ChangeDirection,
        options?: StoreOperationOptions
    ): Promise<void> => {
        const context = createWriteContext(this.runtime, handle, options)
        const plan = await buildChangeWritePlan({
            runtime: this.runtime,
            handle,
            opContext: context.opContext,
            changes,
            direction,
            options,
            createEntryId: () => this.runtime.nextOpId(handle.storeName, 'w')
        })
        if (!plan.length) return

        await this.commitWrite({
            handle,
            ...context,
            plan,
            source: 'applyChanges'
        })
    }
}
