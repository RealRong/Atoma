import { createActionId } from '#core/operationContext'
import type {
    CoreRuntime,
    Entity,
    LifecycleHooks,
    OperationContext,
    PartialWithId,
    PersistWriteback,
    StoreDispatchEvent,
    StoreOperationOptions,
    WriteStrategy,
    WriteTicket
} from '#core'
import type { StoreHandle } from '#core/store/internals/handleTypes'
import { StoreStateWriter } from '#core/store/internals/StoreStateWriter'
import { StoreWriteUtils } from '#core/store/internals/StoreWriteUtils'

export class StoreWriteCoordinator {
    constructor(
        private readonly runtime: CoreRuntime,
        private readonly dispatchMutation: (event: StoreDispatchEvent<any>) => void
    ) {}

    resolveWriteStrategy<T extends Entity>(handle: StoreHandle<T>, options?: StoreOperationOptions | undefined): WriteStrategy | undefined {
        return options?.writeStrategy ?? handle.defaultWriteStrategy
    }

    allowImplicitFetchForWrite(writeStrategy?: WriteStrategy): boolean {
        // Only 'queue' forbids implicit fetch during write. All other strategies keep DX-friendly behavior.
        return writeStrategy !== 'queue'
    }

    async prepareForAdd<T extends Entity>(
        handle: StoreHandle<T>,
        item: Partial<T>,
        opContext?: OperationContext
    ): Promise<PartialWithId<T>> {
        let initedObj = StoreWriteUtils.initBaseObject<T>(item, handle.idGenerator)
        initedObj = await this.runBeforeSave(handle.hooks, initedObj, 'add')
        const processed = await this.runtime.transform.inbound(handle, initedObj as T, opContext)
        return this.requireProcessed(processed as PartialWithId<T> | undefined, 'prepareForAdd')
    }

    async prepareForUpdate<T extends Entity>(
        handle: StoreHandle<T>,
        base: PartialWithId<T>,
        patch: PartialWithId<T>,
        opContext?: OperationContext
    ): Promise<PartialWithId<T>> {
        let merged = StoreWriteUtils.mergeForUpdate(base, patch)
        merged = await this.runBeforeSave(handle.hooks, merged, 'update')
        const processed = await this.runtime.transform.inbound(handle, merged as T, opContext)
        return this.requireProcessed(processed as PartialWithId<T> | undefined, 'prepareForUpdate')
    }

    async runBeforeSave<T>(
        hooks: LifecycleHooks<T> | undefined,
        item: PartialWithId<T>,
        action: 'add' | 'update'
    ): Promise<PartialWithId<T>> {
        if (hooks?.beforeSave) {
            return await hooks.beforeSave({ action, item })
        }
        return item
    }

    async runAfterSave<T>(
        hooks: LifecycleHooks<T> | undefined,
        item: PartialWithId<T>,
        action: 'add' | 'update'
    ): Promise<void> {
        if (hooks?.afterSave) {
            await hooks.afterSave({ action, item })
        }
    }

    ensureActionId(opContext: OperationContext | undefined): OperationContext | undefined {
        if (!opContext) {
            return {
                scope: 'default',
                origin: 'user',
                actionId: createActionId()
            }
        }
        if (typeof opContext.actionId === 'string' && opContext.actionId) return opContext
        return {
            ...opContext,
            actionId: createActionId()
        }
    }

    ignoreTicketRejections(ticket: WriteTicket) {
        void ticket.enqueued.catch(() => {
            // avoid unhandled rejection when optimistic writes never await enqueued
        })
        void ticket.confirmed.catch(() => {
            // avoid unhandled rejection when optimistic writes never await confirmed
        })
    }

    dispatch<T extends Entity>(event: StoreDispatchEvent<T>) {
        this.dispatchMutation(event)
    }

    applyWriteback = async <T extends Entity>(
        handle: StoreHandle<T>,
        writeback: PersistWriteback<T>
    ): Promise<void> => {
        const upserts = writeback?.upserts ?? []
        const deletes = writeback?.deletes ?? []
        const versionUpdates = writeback?.versionUpdates ?? []

        if (!upserts.length && !deletes.length && !versionUpdates.length) return

        const processed = (await Promise.all(
            upserts.map(item => this.runtime.transform.writeback(handle, item))
        )).filter(Boolean) as T[]

        const stateWriter = new StoreStateWriter(handle)
        stateWriter.applyWriteback({
            upserts: processed,
            deletes,
            versionUpdates
        })
    }

    private requireProcessed<T>(value: T | undefined, tag: string): T {
        if (value === undefined) {
            throw new Error(`[Atoma] ${tag}: transform returned empty`)
        }
        return value
    }
}
