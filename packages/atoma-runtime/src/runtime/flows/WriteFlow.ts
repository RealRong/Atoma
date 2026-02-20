import type {
    Entity,
    PartialWithId,
    StoreChange,
    StoreOperationOptions,
    StoreUpdater,
    UpsertWriteOptions,
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
    PlannedChange,
    WriteInput,
    WritePlan,
    WriteScope,
} from './write/types'
import { runBatch } from './write/utils/batch'

function createWriteSession<T extends Entity>(
    runtime: Runtime,
    handle: StoreHandle<T>,
    options?: StoreOperationOptions
): WriteScope<T> {
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
        session: WriteScope<T>
        plan: WritePlan<T>
        source: WriteEventSource
        output?: T
    }): Promise<T | void> => {
        const { handle, context, route } = session
        const storeName = handle.storeName
        const events = this.runtime.events
        const writeEntries = plan.map(planEntry => planEntry.entry)

        events.emit.writeStart({
            storeName,
            context,
            source,
            route,
            writeEntries
        })

        try {
            const commitResult = await commitWrite<T>({
                runtime: this.runtime,
                scope: session,
                plan,
            })

            const finalValue = commitResult.output ?? output
            events.emit.writeCommitted({
                storeName,
                context,
                route,
                writeEntries,
                result: finalValue,
                changes: commitResult.changes
            })

            return finalValue
        } catch (error) {
            events.emit.writeFailed({
                storeName,
                context,
                route,
                writeEntries,
                error
            })
            throw error
        }
    }

    private preparePlannedChanges = async <T extends Entity>({
        scope,
        changes
    }: {
        scope: WriteScope<T>
        changes: ReadonlyArray<StoreChange<T>>
    }): Promise<ReadonlyArray<PlannedChange<T>>> => {
        const planned: PlannedChange<T>[] = []
        for (const change of changes) {
            if (change.after === undefined) {
                planned.push(change)
                continue
            }

            const outbound = await this.runtime.transform.outbound(scope.handle, change.after, scope.context)
            if (outbound === undefined) {
                throw new Error('[Atoma] transform returned empty for outbound write')
            }

            planned.push({
                id: change.id,
                before: change.before,
                after: change.after,
                outbound
            })
        }
        return planned
    }

    private runInput = async <T extends Entity>({
        session,
        input
    }: {
        session: WriteScope<T>
        input: WriteInput<T>
    }): Promise<T | void> => {
        const adapted = input.kind === 'intent'
            ? await adaptIntentToChanges(this.runtime, input)
            : {
                changes: adaptReplayChanges(
                    input.changes,
                    input.source === 'apply' ? 'forward' : 'backward'
                )
            }
        const source: WriteEventSource = input.kind === 'intent'
            ? input.action
            : input.source

        const plannedChanges = await this.preparePlannedChanges({
            scope: session,
            changes: adapted.changes
        })
        const plan = buildPlan({
            now: this.runtime.now,
            snapshot: session.handle.state.snapshot(),
            changes: plannedChanges,
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
        session: WriteScope<T>,
        intent: IntentCommand<T>
    ): Promise<T | void> => {
        return await this.runInput({
            session,
            input: {
                kind: 'intent',
                scope: session,
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

    apply = async <T extends Entity>(
        handle: StoreHandle<T>,
        changes: ReadonlyArray<StoreChange<T>>,
        options?: StoreOperationOptions
    ): Promise<void> => {
        const session = createWriteSession(this.runtime, handle, options)
        await this.runInput({
            session,
            input: {
                kind: 'change-replay',
                options,
                source: 'apply',
                changes
            }
        })
    }

    revert = async <T extends Entity>(
        handle: StoreHandle<T>,
        changes: ReadonlyArray<StoreChange<T>>,
        options?: StoreOperationOptions
    ): Promise<void> => {
        const session = createWriteSession(this.runtime, handle, options)
        await this.runInput({
            session,
            input: {
                kind: 'change-replay',
                options,
                source: 'revert',
                changes
            }
        })
    }
}
