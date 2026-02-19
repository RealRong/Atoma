import type {
    ChangeDirection,
    Entity,
    ActionContext,
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
    EntityIntentCommand,
    IntentInput,
    IntentCommand,
    WriteInput,
    WritePlan
} from './write/types'
import { runBatch } from './write/utils/batch'

type WriteSession<T extends Entity> = Readonly<{
    handle: StoreHandle<T>
    context: ActionContext
    route?: ExecutionRoute
    signal?: AbortSignal
    createEntryId: () => string
}>

type IntentSource = Exclude<WriteEventSource, 'applyChanges'>
type EntityIntentSource = Exclude<IntentSource, 'delete'>

function createWriteSession<T extends Entity>(
    runtime: Runtime,
    handle: StoreHandle<T>,
    options?: StoreOperationOptions
): WriteSession<T> {
    return {
        handle,
        context: runtime.engine.action.createContext(options?.context),
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
        context: session.context,
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
        const { handle, context, route, signal } = session
        const events = this.runtime.events
        const writeEntries = plan.map(planEntry => planEntry.entry)

        events.emit.writeStart({
            handle,
            context,
            source,
            route,
            writeEntries
        })

        try {
            const commitResult = await this.writeCommitFlow.execute<T>({
                runtime: this.runtime,
                handle,
                context,
                route,
                signal,
                plan,
            })

            const finalValue = commitResult.output ?? output
            events.emit.writeCommitted({
                handle,
                context,
                route,
                writeEntries,
                result: finalValue,
                changes: commitResult.changes
            })

            return finalValue
        } catch (error) {
            events.emit.writeFailed({
                handle,
                context,
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
            context: session.context,
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
        session,
        intent
    }: {
        handle: StoreHandle<T>
        source: IntentSource
        session?: WriteSession<T>
        intent: IntentCommand<T>
    }): Promise<T | void> => {
        const writeSession = session ?? createWriteSession(this.runtime, handle, intent.options)
        return await this.runInput({
            session: writeSession,
            input: this.createIntentInput(writeSession, intent),
            source
        })
    }

    private runEntityIntent = async <T extends Entity>({
        handle,
        source,
        session,
        intent
    }: {
        handle: StoreHandle<T>
        source: EntityIntentSource
        session?: WriteSession<T>
        intent: EntityIntentCommand<T>
    }): Promise<T> => {
        const output = await this.runIntent({
            handle,
            source,
            session,
            intent
        })
        if (output === undefined) {
            throw new Error('[Atoma] write intent must resolve entity output')
        }
        return output as T
    }

    private runEntityBatch = async <T extends Entity, Input>({
        handle,
        items,
        options,
        source,
        createIntent
    }: {
        handle: StoreHandle<T>
        items: Input[]
        options?: StoreOperationOptions
        source: EntityIntentSource
        createIntent: (item: Input) => EntityIntentCommand<T>
    }): Promise<WriteManyResult<T>> => {
        const session = createWriteSession(this.runtime, handle, options)
        return await runBatch({
            items,
            options,
            runner: (entry) => this.runEntityIntent({
                handle,
                session,
                source,
                intent: createIntent(entry)
            })
        })
    }

    private runDeleteBatch = async <T extends Entity>({
        handle,
        ids,
        options
    }: {
        handle: StoreHandle<T>
        ids: EntityId[]
        options?: StoreOperationOptions
    }): Promise<WriteManyResult<boolean>> => {
        const session = createWriteSession(this.runtime, handle, options)
        return await runBatch({
            items: ids,
            options,
            runner: (id) => this.runIntent({
                handle,
                session,
                source: 'delete',
                intent: {
                    action: 'delete',
                    options,
                    id
                }
            }).then(() => true)
        })
    }

    create = async <T extends Entity>(handle: StoreHandle<T>, item: Partial<T>, options?: StoreOperationOptions): Promise<T> => {
        return await this.runEntityIntent({
            handle,
            source: 'create',
            intent: {
                action: 'create',
                options,
                item
            }
        })
    }

    createMany = async <T extends Entity>(
        handle: StoreHandle<T>,
        items: Array<Partial<T>>,
        options?: StoreOperationOptions
    ): Promise<WriteManyResult<T>> => {
        return await this.runEntityBatch({
            handle,
            items,
            options,
            source: 'create',
            createIntent: (entry) => ({
                action: 'create',
                options,
                item: entry
            })
        })
    }

    update = async <T extends Entity>(handle: StoreHandle<T>, id: EntityId, updater: StoreUpdater<T>, options?: StoreOperationOptions): Promise<T> => {
        return await this.runEntityIntent({
            handle,
            source: 'update',
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
        return await this.runEntityBatch({
            handle,
            items,
            options,
            source: 'update',
            createIntent: (entry) => ({
                action: 'update',
                options,
                id: entry.id,
                updater: entry.updater
            })
        })
    }

    upsert = async <T extends Entity>(handle: StoreHandle<T>, item: PartialWithId<T>, options?: StoreOperationOptions & UpsertWriteOptions): Promise<T> => {
        return await this.runEntityIntent({
            handle,
            source: 'upsert',
            intent: {
                action: 'upsert',
                options,
                item
            }
        })
    }

    upsertMany = async <T extends Entity>(handle: StoreHandle<T>, items: Array<PartialWithId<T>>, options?: StoreOperationOptions & UpsertWriteOptions): Promise<WriteManyResult<T>> => {
        return await this.runEntityBatch({
            handle,
            items,
            options,
            source: 'upsert',
            createIntent: (entry) => ({
                action: 'upsert',
                options,
                item: entry
            })
        })
    }

    delete = async <T extends Entity>(handle: StoreHandle<T>, id: EntityId, options?: StoreOperationOptions): Promise<boolean> => {
        await this.runIntent({
            handle,
            source: 'delete',
            intent: {
                action: 'delete',
                options,
                id
            }
        })

        return true
    }

    deleteMany = async <T extends Entity>(handle: StoreHandle<T>, ids: EntityId[], options?: StoreOperationOptions): Promise<WriteManyResult<boolean>> => {
        return await this.runDeleteBatch({
            handle,
            ids,
            options
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
