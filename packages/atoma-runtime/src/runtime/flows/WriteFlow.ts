import type {
    Entity,
    PartialWithId,
    StoreOperationOptions,
    StoreUpdater,
    UpsertWriteOptions,
    WriteManyResult
} from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import type { Runtime, Write, StoreHandle } from 'atoma-types/runtime'
import { orchestrateWrite } from './write/orchestrateWrite'
import type {
    PreparedWrites,
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
        signal: options?.signal
    }
}

export class WriteFlow implements Write {
    private readonly runtime: Runtime

    constructor(runtime: Runtime) {
        this.runtime = runtime
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
        const { prepared, results } = await orchestrateWrite({
            runtime: this.runtime,
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
        const { results } = await orchestrateWrite({
            runtime: this.runtime,
            session,
            source: 'create',
            intents: items.map((item) => ({ action: 'create', options, item }))
        })
        return results as WriteManyResult<T>
    }

    update = async <T extends Entity>(handle: StoreHandle<T>, id: EntityId, updater: StoreUpdater<T>, options?: StoreOperationOptions): Promise<T> => {
        const session = createWriteSession(this.runtime, handle, options)
        const { prepared, results } = await orchestrateWrite({
            runtime: this.runtime,
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
        const { results } = await orchestrateWrite({
            runtime: this.runtime,
            session,
            source: 'update',
            intents: items.map((item) => ({ action: 'update', options, id: item.id, updater: item.updater }))
        })
        return results as WriteManyResult<T>
    }

    upsert = async <T extends Entity>(handle: StoreHandle<T>, item: PartialWithId<T>, options?: StoreOperationOptions & UpsertWriteOptions): Promise<T> => {
        const session = createWriteSession(this.runtime, handle, options)
        const { prepared, results } = await orchestrateWrite({
            runtime: this.runtime,
            session,
            source: 'upsert',
            intents: [{ action: 'upsert', options, item }]
        })
        return this.unwrapSingleResult({ prepared, results }) as T
    }

    upsertMany = async <T extends Entity>(handle: StoreHandle<T>, items: Array<PartialWithId<T>>, options?: StoreOperationOptions & UpsertWriteOptions): Promise<WriteManyResult<T>> => {
        const session = createWriteSession(this.runtime, handle, options)
        const { results } = await orchestrateWrite({
            runtime: this.runtime,
            session,
            source: 'upsert',
            intents: items.map((item) => ({ action: 'upsert', options, item }))
        })
        return results as WriteManyResult<T>
    }

    delete = async <T extends Entity>(handle: StoreHandle<T>, id: EntityId, options?: StoreOperationOptions): Promise<void> => {
        const session = createWriteSession(this.runtime, handle, options)
        const { prepared, results } = await orchestrateWrite({
            runtime: this.runtime,
            session,
            source: 'delete',
            intents: [{ action: 'delete', options, id }]
        })
        this.unwrapSingleResult({ prepared, results })
    }

    deleteMany = async <T extends Entity>(handle: StoreHandle<T>, ids: EntityId[], options?: StoreOperationOptions): Promise<WriteManyResult<void>> => {
        const session = createWriteSession(this.runtime, handle, options)
        const { results } = await orchestrateWrite({
            runtime: this.runtime,
            session,
            source: 'delete',
            intents: ids.map((id) => ({ action: 'delete', options, id }))
        })
        return results as WriteManyResult<void>
    }
}
