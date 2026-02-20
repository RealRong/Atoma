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
import { createId } from 'atoma-shared'
import { commitWrite } from './write/commit/commitWrite'
import { adaptIntentToChanges } from './write/adapters/intentToChanges'
import { adaptReplayChanges } from './write/adapters/replayToChanges'
import { buildPlan } from './write/planner/buildPlan'
import type {
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

function createWriteSession<T extends Entity>(
    runtime: Runtime,
    handle: StoreHandle<T>,
    options?: StoreOperationOptions
): WriteSession<T> {
    const createEntryId = () => createId({
        kind: 'action',
        sortable: true,
        prefix: 'w',
        now: runtime.now
    })

    return {
        handle,
        context: runtime.engine.action.createContext(options?.context),
        route: options?.route ?? handle.config.defaultRoute,
        signal: options?.signal,
        createEntryId
    }
}

export class WriteFlow implements Write {
    private readonly runtime: Runtime

    constructor(runtime: Runtime) {
        this.runtime = runtime
    }

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
            const commitResult = await commitWrite<T>({
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
        input
    }: {
        session: WriteSession<T>
        input: WriteInput<T>
    }): Promise<T | void> => {
        const adapted = input.kind === 'intent'
            ? await adaptIntentToChanges(this.runtime, input)
            : { changes: input.changes }
        const source: WriteEventSource = input.kind === 'intent'
            ? input.action
            : 'applyChanges'

        const plan = await buildPlan({
            runtime: this.runtime,
            handle: session.handle,
            context: session.context,
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

    private runIntent = async <T extends Entity>(
        session: WriteSession<T>,
        intent: IntentCommand<T>
    ): Promise<T | void> => {
        return await this.runInput({
            session,
            input: {
                kind: 'intent',
                handle: session.handle,
                context: session.context,
                ...intent
            }
        })
    }

    create = async <T extends Entity>(handle: StoreHandle<T>, item: Partial<T>, options?: StoreOperationOptions): Promise<T> => {
        const session = createWriteSession(this.runtime, handle, options)
        return await this.runIntent(session, { action: 'create', options, item }) as T
    }

    createMany = async <T extends Entity>(
        handle: StoreHandle<T>,
        items: Array<Partial<T>>,
        options?: StoreOperationOptions
    ): Promise<WriteManyResult<T>> => {
        const session = createWriteSession(this.runtime, handle, options)
        return await runBatch({
            items,
            options,
            runner: (item) => this.runIntent(session, { action: 'create', options, item }) as Promise<T>
        })
    }

    update = async <T extends Entity>(handle: StoreHandle<T>, id: EntityId, updater: StoreUpdater<T>, options?: StoreOperationOptions): Promise<T> => {
        const session = createWriteSession(this.runtime, handle, options)
        return await this.runIntent(session, { action: 'update', options, id, updater }) as T
    }

    updateMany = async <T extends Entity>(
        handle: StoreHandle<T>,
        items: Array<{ id: EntityId; updater: StoreUpdater<T> }>,
        options?: StoreOperationOptions
    ): Promise<WriteManyResult<T>> => {
        const session = createWriteSession(this.runtime, handle, options)
        return await runBatch({
            items,
            options,
            runner: (item) => this.runIntent(session, { action: 'update', options, id: item.id, updater: item.updater }) as Promise<T>
        })
    }

    upsert = async <T extends Entity>(handle: StoreHandle<T>, item: PartialWithId<T>, options?: StoreOperationOptions & UpsertWriteOptions): Promise<T> => {
        const session = createWriteSession(this.runtime, handle, options)
        return await this.runIntent(session, { action: 'upsert', options, item }) as T
    }

    upsertMany = async <T extends Entity>(handle: StoreHandle<T>, items: Array<PartialWithId<T>>, options?: StoreOperationOptions & UpsertWriteOptions): Promise<WriteManyResult<T>> => {
        const session = createWriteSession(this.runtime, handle, options)
        return await runBatch({
            items,
            options,
            runner: (item) => this.runIntent(session, { action: 'upsert', options, item }) as Promise<T>
        })
    }

    delete = async <T extends Entity>(handle: StoreHandle<T>, id: EntityId, options?: StoreOperationOptions): Promise<void> => {
        const session = createWriteSession(this.runtime, handle, options)
        await this.runIntent(session, { action: 'delete', options, id })
    }

    deleteMany = async <T extends Entity>(handle: StoreHandle<T>, ids: EntityId[], options?: StoreOperationOptions): Promise<WriteManyResult<void>> => {
        const session = createWriteSession(this.runtime, handle, options)
        return await runBatch({
            items: ids,
            options,
            runner: (id) => this.runIntent(session, { action: 'delete', options, id }).then(() => undefined)
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
                changes: adaptReplayChanges(changes, direction)
            }
        })
    }
}
