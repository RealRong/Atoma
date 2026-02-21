import type {
    Entity,
    PartialWithId,
    StoreOperationOptions,
    StoreUpdater,
    UpsertWriteOptions,
    WriteManyResult
} from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import type { Runtime, Write, WriteEntry, WriteEventSource, StoreHandle } from 'atoma-types/runtime'
import { commitWrites } from './write/commit/commitWrites'
import { prepareWrites } from './write/prepare/prepareWrite'
import type {
    IntentCommand,
    IntentInput,
    PreparedWrites,
    WriteCommitResult,
    WriteScope,
} from './write/types'

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

    private ensureUniqueIds = (entries: ReadonlyArray<WriteEntry>) => {
        const seen = new Set<string>()
        entries.forEach((entry, index) => {
            const id = String(entry.item.id ?? '').trim()
            if (!id) return
            if (seen.has(id)) {
                throw new Error(`[Atoma] writeMany: duplicate item id in batch (id=${id}, index=${index})`)
            }
            seen.add(id)
        })
    }

    private commitPrepared = async <T extends Entity>({
        session,
        source,
        prepared
    }: {
        session: WriteScope<T>
        source: WriteEventSource
        prepared: PreparedWrites<T>
    }): Promise<WriteCommitResult<T>> => {
        const { handle, context, route } = session
        const storeName = handle.storeName
        const events = this.runtime.events
        const writeEntries = prepared.map((item) => item.entry)

        events.emit.writeStart({
            storeName,
            context,
            source,
            route,
            writeEntries
        })

        try {
            const commitResult = await commitWrites<T>({
                runtime: this.runtime,
                scope: session,
                prepared,
            })

            const singleResult = prepared.length === 1
                ? commitResult.results[0]
                : undefined
            if (prepared.length === 1) {
                if (!singleResult) {
                    throw new Error('[Atoma] write: missing write result at index=0')
                }
                if (!singleResult.ok) {
                    throw singleResult.error
                }
            }

            events.emit.writeCommitted({
                storeName,
                context,
                route,
                writeEntries,
                ...(singleResult?.ok ? { result: singleResult.value } : {}),
                changes: commitResult.changes
            })

            return commitResult
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

    private runIntents = async <T extends Entity>({
        session,
        source,
        intents
    }: {
        session: WriteScope<T>
        source: WriteEventSource
        intents: ReadonlyArray<IntentCommand<T>>
    }): Promise<{
        prepared: PreparedWrites<T>
        results: WriteManyResult<T | void>
    }> => {
        if (!intents.length) {
            return {
                prepared: [],
                results: []
            }
        }

        const inputs: IntentInput<T>[] = intents.map((intent) => ({
            kind: 'intent',
            scope: session,
            ...intent
        }))
        const prepared = await prepareWrites(this.runtime, inputs)
        this.ensureUniqueIds(prepared.map((item) => item.entry))

        const commitResult = await this.commitPrepared({
            session,
            source,
            prepared
        })

        return {
            prepared,
            results: commitResult.results
        }
    }

    private unwrapSingleResult = <T extends Entity>({
        prepared,
        results
    }: {
        prepared: PreparedWrites<T>
        results: WriteManyResult<T | void>
    }): T | void => {
        const preparedWrite = prepared[0]
        const result = results[0]
        if (!preparedWrite || !result || !result.ok) {
            throw new Error('[Atoma] write: missing write result at index=0')
        }

        return (result.value ?? preparedWrite.output) as T | void
    }

    create = async <T extends Entity>(handle: StoreHandle<T>, item: Partial<T>, options?: StoreOperationOptions): Promise<T> => {
        const session = createWriteSession(this.runtime, handle, options)
        const { prepared, results } = await this.runIntents({
            session,
            source: 'create',
            intents: [{ action: 'create', options, item }]
        })
        return this.unwrapSingleResult({ prepared, results }) as T
    }

    createMany = async <T extends Entity>(
        handle: StoreHandle<T>,
        items: Array<Partial<T>>,
        options?: StoreOperationOptions
    ): Promise<WriteManyResult<T>> => {
        const session = createWriteSession(this.runtime, handle, options)
        const { results } = await this.runIntents({
            session,
            source: 'create',
            intents: items.map((item) => ({ action: 'create', options, item }))
        })
        return results as WriteManyResult<T>
    }

    update = async <T extends Entity>(handle: StoreHandle<T>, id: EntityId, updater: StoreUpdater<T>, options?: StoreOperationOptions): Promise<T> => {
        const session = createWriteSession(this.runtime, handle, options)
        const { prepared, results } = await this.runIntents({
            session,
            source: 'update',
            intents: [{ action: 'update', options, id, updater }]
        })
        return this.unwrapSingleResult({ prepared, results }) as T
    }

    updateMany = async <T extends Entity>(
        handle: StoreHandle<T>,
        items: Array<{ id: EntityId; updater: StoreUpdater<T> }>,
        options?: StoreOperationOptions
    ): Promise<WriteManyResult<T>> => {
        const session = createWriteSession(this.runtime, handle, options)
        const { results } = await this.runIntents({
            session,
            source: 'update',
            intents: items.map((item) => ({ action: 'update', options, id: item.id, updater: item.updater }))
        })
        return results as WriteManyResult<T>
    }

    upsert = async <T extends Entity>(handle: StoreHandle<T>, item: PartialWithId<T>, options?: StoreOperationOptions & UpsertWriteOptions): Promise<T> => {
        const session = createWriteSession(this.runtime, handle, options)
        const { prepared, results } = await this.runIntents({
            session,
            source: 'upsert',
            intents: [{ action: 'upsert', options, item }]
        })
        return this.unwrapSingleResult({ prepared, results }) as T
    }

    upsertMany = async <T extends Entity>(handle: StoreHandle<T>, items: Array<PartialWithId<T>>, options?: StoreOperationOptions & UpsertWriteOptions): Promise<WriteManyResult<T>> => {
        const session = createWriteSession(this.runtime, handle, options)
        const { results } = await this.runIntents({
            session,
            source: 'upsert',
            intents: items.map((item) => ({ action: 'upsert', options, item }))
        })
        return results as WriteManyResult<T>
    }

    delete = async <T extends Entity>(handle: StoreHandle<T>, id: EntityId, options?: StoreOperationOptions): Promise<void> => {
        const session = createWriteSession(this.runtime, handle, options)
        const { prepared, results } = await this.runIntents({
            session,
            source: 'delete',
            intents: [{ action: 'delete', options, id }]
        })
        this.unwrapSingleResult({ prepared, results })
    }

    deleteMany = async <T extends Entity>(handle: StoreHandle<T>, ids: EntityId[], options?: StoreOperationOptions): Promise<WriteManyResult<void>> => {
        const session = createWriteSession(this.runtime, handle, options)
        const { results } = await this.runIntents({
            session,
            source: 'delete',
            intents: ids.map((id) => ({ action: 'delete', options, id }))
        })
        return results as WriteManyResult<void>
    }
}
