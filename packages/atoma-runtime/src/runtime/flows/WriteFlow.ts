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
import { orchestrateWrite } from './write/orchestrate'
import type { IntentCommandByAction, NonDeleteIntentAction, WriteScope } from './write/contracts'

export class WriteFlow implements Write {
    private readonly runtime: Runtime

    constructor(runtime: Runtime) {
        this.runtime = runtime
    }

    private createScope<T extends Entity>(handle: StoreHandle<T>, options?: StoreOperationOptions): WriteScope<T> {
        return {
            handle,
            context: this.runtime.engine.action.createContext(options?.context),
            signal: options?.signal
        }
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
        const scope = this.createScope(handle, options)
        const { prepared, results } = await orchestrateWrite({
            runtime: this.runtime,
            scope,
            source,
            intents: [intent]
        })
        const preparedWrite = prepared[0]
        const result = results[0]
        if (!preparedWrite || !result) {
            throw new Error('[Atoma] write: missing write result at index=0')
        }
        if (!result.ok) {
            throw result.error
        }

        if (source === 'delete') {
            return
        }
        const output = result.value ?? preparedWrite.output
        if (output === undefined) {
            throw new Error('[Atoma] write: missing write output at index=0')
        }
        return output
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
        const scope = this.createScope(handle, options)
        const { results } = await orchestrateWrite({
            runtime: this.runtime,
            scope,
            source,
            intents
        })
        if (source === 'delete') {
            return results.map((item) => item.ok
                ? { index: item.index, ok: true, value: undefined }
                : item
            )
        }
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

    create = async <T extends Entity>(handle: StoreHandle<T>, item: Partial<T>, options?: StoreOperationOptions): Promise<T> => {
        return this.runSingle({
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
        return this.runMany({
            handle,
            options,
            source: 'create',
            intents: items.map((item) => ({ action: 'create', options, item }))
        })
    }

    update = async <T extends Entity>(handle: StoreHandle<T>, id: EntityId, updater: StoreUpdater<T>, options?: StoreOperationOptions): Promise<T> => {
        return this.runSingle({
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
        return this.runMany({
            handle,
            options,
            source: 'update',
            intents: items.map((item) => ({ action: 'update', options, id: item.id, updater: item.updater }))
        })
    }

    upsert = async <T extends Entity>(handle: StoreHandle<T>, item: PartialWithId<T>, options?: StoreOperationOptions & UpsertWriteOptions): Promise<T> => {
        return this.runSingle({
            handle,
            options,
            source: 'upsert',
            intent: { action: 'upsert', options, item }
        })
    }

    upsertMany = async <T extends Entity>(handle: StoreHandle<T>, items: Array<PartialWithId<T>>, options?: StoreOperationOptions & UpsertWriteOptions): Promise<WriteManyResult<T>> => {
        return this.runMany({
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
        return this.runMany({
            handle,
            options,
            source: 'delete',
            intents: ids.map((id) => ({ action: 'delete', options, id }))
        })
    }
}
