import type {
    Entity,
    PartialWithId,
    StoreOperationOptions,
    StoreUpdater,
    UpsertWriteOptions,
    WriteManyResult
} from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import type { Runtime, Write, WriteEventSource, StoreHandle } from 'atoma-types/runtime'
import { commitWrite } from './write/commit/commitWrite'
import { compileIntentToWrite } from './write/adapters/intentToWrite'
import type {
    IntentInput,
    IntentCommand,
    PreparedWrite,
    WriteScope,
} from './write/types'
import { runBatch } from './write/utils/batch'

function createWriteSession<T extends Entity>(
    runtime: Runtime,
    handle: StoreHandle<T>,
    options?: StoreOperationOptions
): WriteScope<T> {
    return {
        handle,
        context: runtime.engine.action.createContext(options?.context),
        route: options?.route ?? handle.config.defaultRoute,
        signal: options?.signal
    }
}

export class WriteFlow implements Write {
    private readonly runtime: Runtime

    constructor(runtime: Runtime) {
        this.runtime = runtime
    }

    private commitWrite = async <T extends Entity>({
        session,
        prepared,
        source,
        output: localOutput
    }: {
        session: WriteScope<T>
        prepared: PreparedWrite<T>
        source: WriteEventSource
        output?: T
    }): Promise<T | void> => {
        const { handle, context, route } = session
        const storeName = handle.storeName
        const events = this.runtime.events
        const writeEntries = [prepared.entry]

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
                prepared,
            })

            const finalValue = commitResult.output ?? localOutput
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

    private runInput = async <T extends Entity>({
        session,
        input
    }: {
        session: WriteScope<T>
        input: IntentInput<T>
    }): Promise<T | void> => {
        const prepared = await compileIntentToWrite(this.runtime, input)

        return await this.commitWrite({
            session,
            prepared,
            source: input.action,
            output: prepared.output
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
}
