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
import { adaptIntentToChanges } from './write/adapters/intentToChanges'
import { adaptReplayChanges } from './write/adapters/replayToChanges'
import { buildPlanFromChanges } from './write/planner/buildPlanFromChanges'
import type {
    IntentInput,
    WriteInput,
    WritePlan
} from './write/types'
import { runBatch, runBatchOrThrow } from './write/utils/batch'

type WriteSession<T extends Entity> = Readonly<{
    handle: StoreHandle<T>
    opContext: OperationContext
    route?: ExecutionRoute
    signal?: AbortSignal
    createEntryId: () => string
}>

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never
type IntentCommand<T extends Entity> = DistributiveOmit<IntentInput<T>, 'kind' | 'handle' | 'opContext'>
type EntityIntentCommand<T extends Entity> = Exclude<IntentCommand<T>, { action: 'delete' }>
type IntentSource = Exclude<WriteEventSource, 'applyChanges'>
type EntityIntentSource = Exclude<IntentSource, 'deleteOne'>

function createWriteSession<T extends Entity>(
    runtime: Runtime,
    handle: StoreHandle<T>,
    options?: StoreOperationOptions
): WriteSession<T> {
    return {
        handle,
        opContext: runtime.engine.operation.createContext(options?.opContext),
        route: options?.route ?? handle.config.defaultRoute,
        signal: options?.signal,
        createEntryId: () => runtime.nextOpId(handle.storeName, 'w')
    }
}

export class WriteFlow implements Write {
    private readonly runtime: Runtime
    private readonly writeCommitFlow: WriteCommitFlow

    constructor(runtime: Runtime) {
        this.runtime = runtime
        this.writeCommitFlow = new WriteCommitFlow()
    }

    private createIntentInput = <T extends Entity>(
        session: WriteSession<T>,
        intent: IntentCommand<T>
    ): IntentInput<T> => ({
        kind: 'intent',
        handle: session.handle,
        opContext: session.opContext,
        ...intent
    })

    private commitWrite = async <T extends Entity>({
        session,
        plan,
        source,
        output
    }: {
        session: WriteSession<T>
        plan: WritePlan<T>
        source: WriteEventSource
        output?: T
    }): Promise<T | void> => {
        const { handle, opContext, route, signal } = session
        const events = this.runtime.events
        const writeEntries = plan.map(planEntry => planEntry.entry)

        events.emit.writeStart({
            handle,
            opContext,
            entryCount: plan.length,
            source,
            route,
            writeEntries
        })

        try {
            const commitResult = await this.writeCommitFlow.execute<T>({
                runtime: this.runtime,
                handle,
                opContext,
                route,
                signal,
                plan,
            })

            const finalValue = commitResult.output ?? output
            events.emit.writeCommitted({
                handle,
                opContext,
                route,
                writeEntries,
                result: finalValue,
                changes: commitResult.changes
            })

            return finalValue
        } catch (error) {
            events.emit.writeFailed({
                handle,
                opContext,
                route,
                writeEntries,
                error
            })
            throw error
        }
    }

    private runInput = async <T extends Entity>({
        session,
        input,
        source
    }: {
        session: WriteSession<T>
        input: WriteInput<T>
        source: WriteEventSource
    }): Promise<T | void> => {
        const adapted = input.kind === 'intent'
            ? await adaptIntentToChanges({
                runtime: this.runtime,
                input
            })
            : { changes: input.changes }

        const plan = await buildPlanFromChanges({
            runtime: this.runtime,
            handle: session.handle,
            opContext: session.opContext,
            options: input.options,
            changes: adapted.changes,
            policy: adapted.policy,
            createEntryId: session.createEntryId
        })
        if (!plan.length) {
            return adapted.output
        }

        return await this.commitWrite({
            session,
            plan,
            source,
            output: adapted.output
        })
    }

    private runIntent = async <T extends Entity>({
        handle,
        source,
        intent
    }: {
        handle: StoreHandle<T>
        source: IntentSource
        intent: IntentCommand<T>
    }): Promise<T | void> => {
        const session = createWriteSession(this.runtime, handle, intent.options)
        return await this.runInput({
            session,
            input: this.createIntentInput(session, intent),
            source
        })
    }

    private runEntityIntent = async <T extends Entity>({
        handle,
        source,
        intent
    }: {
        handle: StoreHandle<T>
        source: EntityIntentSource
        intent: EntityIntentCommand<T>
    }): Promise<T> => {
        const output = await this.runIntent({
            handle,
            source,
            intent
        })
        if (output === undefined) {
            throw new Error('[Atoma] write intent must resolve entity output')
        }
        return output as T
    }

    addOne = async <T extends Entity>(handle: StoreHandle<T>, item: Partial<T>, options?: StoreOperationOptions): Promise<T> => {
        return await this.runEntityIntent({
            handle,
            source: 'addOne',
            intent: {
                action: 'add',
                options,
                item
            }
        })
    }

    addMany = async <T extends Entity>(handle: StoreHandle<T>, items: Array<Partial<T>>, options?: StoreOperationOptions): Promise<T[]> => {
        return await runBatchOrThrow({
            items,
            options,
            runner: (entry) => this.addOne(handle, entry, options)
        })
    }

    updateOne = async <T extends Entity>(handle: StoreHandle<T>, id: EntityId, updater: StoreUpdater<T>, options?: StoreOperationOptions): Promise<T> => {
        return await this.runEntityIntent({
            handle,
            source: 'updateOne',
            intent: {
                action: 'update',
                options,
                id,
                updater
            }
        })
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
        return await this.runEntityIntent({
            handle,
            source: 'upsertOne',
            intent: {
                action: 'upsert',
                options,
                item
            }
        })
    }

    upsertMany = async <T extends Entity>(handle: StoreHandle<T>, items: Array<PartialWithId<T>>, options?: StoreOperationOptions & UpsertWriteOptions): Promise<WriteManyResult<T>> => {
        return await runBatch({
            items,
            options,
            runner: (entry) => this.upsertOne(handle, entry, options)
        })
    }

    deleteOne = async <T extends Entity>(handle: StoreHandle<T>, id: EntityId, options?: StoreOperationOptions): Promise<boolean> => {
        await this.runIntent({
            handle,
            source: 'deleteOne',
            intent: {
                action: 'delete',
                options,
                id
            }
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
        const session = createWriteSession(this.runtime, handle, options)
        await this.runInput({
            session,
            input: {
                kind: 'change-replay',
                options,
                changes: adaptReplayChanges({
                    changes,
                    direction
                })
            },
            source: 'applyChanges'
        })
    }
}
