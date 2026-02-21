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
import type { IntentCommandByAction, NonDeleteIntentAction, PreparedWrites, WriteScope } from './write/types'

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

    private unwrapSingleResult<T extends Entity>({
        prepared,
        results
    }: {
        prepared: PreparedWrites<T>
        results: WriteManyResult<T | void>
    }): T | void {
        const preparedWrite = prepared[0]
        const result = results[0]
        if (!preparedWrite || !result || !result.ok) {
            throw new Error('[Atoma] write: missing write result at index=0')
        }

        const output = result.value ?? preparedWrite.output
        return output
    }

    private requireEntityOutput<T extends Entity>(value: T | void): T {
        if (value === undefined) {
            throw new Error('[Atoma] write: missing write output at index=0')
        }
        return value
    }

    private toDeleteResults<T extends Entity>(results: WriteManyResult<T | void>): WriteManyResult<void> {
        return results.map((item) => item.ok
            ? { index: item.index, ok: true, value: undefined }
            : item
        )
    }

    private toEntityResults<T extends Entity>(results: WriteManyResult<T | void>): WriteManyResult<T> {
        return results.map((item) => {
            if (!item.ok) return item
            if (item.value === undefined) {
                throw new Error(`[Atoma] write: missing write output at index=${item.index}`)
            }
            return {
                index: item.index,
                ok: true,
                value: item.value
            }
        })
    }

    private runSingle<T extends Entity>(args: {
        handle: StoreHandle<T>
        options?: StoreOperationOptions
        source: 'delete'
        intent: IntentCommandByAction<T, 'delete'>
    }): Promise<void>
    private runSingle<T extends Entity>(args: {
        handle: StoreHandle<T>
        options?: StoreOperationOptions
        source: NonDeleteIntentAction
        intent: IntentCommandByAction<T, NonDeleteIntentAction>
    }): Promise<T>
    private async runSingle<T extends Entity>({
        handle,
        options,
        source,
        intent
    }:
        | {
            handle: StoreHandle<T>
            options?: StoreOperationOptions
            source: 'delete'
            intent: IntentCommandByAction<T, 'delete'>
        }
        | {
            handle: StoreHandle<T>
            options?: StoreOperationOptions
            source: NonDeleteIntentAction
            intent: IntentCommandByAction<T, NonDeleteIntentAction>
        }): Promise<T | void> {
        const session = createWriteSession(this.runtime, handle, options)
        const { prepared, results } = await orchestrateWrite({
            runtime: this.runtime,
            session,
            source,
            intents: [intent]
        })
        const output = this.unwrapSingleResult({
            prepared,
            results
        })

        if (source === 'delete') {
            return
        }
        return this.requireEntityOutput(output)
    }

    private runMany<T extends Entity>(args: {
        handle: StoreHandle<T>
        options?: StoreOperationOptions
        source: 'delete'
        intents: ReadonlyArray<IntentCommandByAction<T, 'delete'>>
    }): Promise<WriteManyResult<void>>
    private runMany<T extends Entity>(args: {
        handle: StoreHandle<T>
        options?: StoreOperationOptions
        source: NonDeleteIntentAction
        intents: ReadonlyArray<IntentCommandByAction<T, NonDeleteIntentAction>>
    }): Promise<WriteManyResult<T>>
    private async runMany<T extends Entity>({
        handle,
        options,
        source,
        intents
    }:
        | {
            handle: StoreHandle<T>
            options?: StoreOperationOptions
            source: 'delete'
            intents: ReadonlyArray<IntentCommandByAction<T, 'delete'>>
        }
        | {
            handle: StoreHandle<T>
            options?: StoreOperationOptions
            source: NonDeleteIntentAction
            intents: ReadonlyArray<IntentCommandByAction<T, NonDeleteIntentAction>>
        }): Promise<WriteManyResult<T | void>> {
        const session = createWriteSession(this.runtime, handle, options)
        const { results } = await orchestrateWrite({
            runtime: this.runtime,
            session,
            source,
            intents
        })
        if (source === 'delete') {
            return this.toDeleteResults(results)
        }
        return this.toEntityResults(results)
    }

    create = async <T extends Entity>(handle: StoreHandle<T>, item: Partial<T>, options?: StoreOperationOptions): Promise<T> => {
        return await this.runSingle({
            handle,
            options,
            source: 'create',
            intent: { action: 'create', options, item }
        })
    }

    createMany = async <T extends Entity>(
        handle: StoreHandle<T>,
        items: Array<Partial<T>>,
        options?: StoreOperationOptions
    ): Promise<WriteManyResult<T>> => {
        return await this.runMany({
            handle,
            options,
            source: 'create',
            intents: items.map((item) => ({ action: 'create', options, item }))
        })
    }

    update = async <T extends Entity>(handle: StoreHandle<T>, id: EntityId, updater: StoreUpdater<T>, options?: StoreOperationOptions): Promise<T> => {
        return await this.runSingle({
            handle,
            options,
            source: 'update',
            intent: { action: 'update', options, id, updater }
        })
    }

    updateMany = async <T extends Entity>(
        handle: StoreHandle<T>,
        items: Array<{ id: EntityId; updater: StoreUpdater<T> }>,
        options?: StoreOperationOptions
    ): Promise<WriteManyResult<T>> => {
        return await this.runMany({
            handle,
            options,
            source: 'update',
            intents: items.map((item) => ({ action: 'update', options, id: item.id, updater: item.updater }))
        })
    }

    upsert = async <T extends Entity>(handle: StoreHandle<T>, item: PartialWithId<T>, options?: StoreOperationOptions & UpsertWriteOptions): Promise<T> => {
        return await this.runSingle({
            handle,
            options,
            source: 'upsert',
            intent: { action: 'upsert', options, item }
        })
    }

    upsertMany = async <T extends Entity>(handle: StoreHandle<T>, items: Array<PartialWithId<T>>, options?: StoreOperationOptions & UpsertWriteOptions): Promise<WriteManyResult<T>> => {
        return await this.runMany({
            handle,
            options,
            source: 'upsert',
            intents: items.map((item) => ({ action: 'upsert', options, item }))
        })
    }

    delete = async <T extends Entity>(handle: StoreHandle<T>, id: EntityId, options?: StoreOperationOptions): Promise<void> => {
        await this.runSingle({
            handle,
            options,
            source: 'delete',
            intent: { action: 'delete', options, id }
        })
    }

    deleteMany = async <T extends Entity>(handle: StoreHandle<T>, ids: EntityId[], options?: StoreOperationOptions): Promise<WriteManyResult<void>> => {
        return await this.runMany({
            handle,
            options,
            source: 'delete',
            intents: ids.map((id) => ({ action: 'delete', options, id }))
        })
    }
}
