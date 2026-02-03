import { produce, type Draft, type Patch } from 'immer'
import type { Draft as ImmerDraft } from 'immer'
import type { Types } from 'atoma-core'
import { Store } from 'atoma-core'
import type { EntityId } from 'atoma-protocol'
import type { CoreRuntime, RuntimeWrite, StoreHandle } from '../../types/runtimeTypes'
import { applyPersistAck, resolveOutputFromAck } from './finalize'
import { buildWriteOps } from '../persistence/persist'
import { ensureActionId, prepareForAdd, prepareForUpdate, resolveBaseForWrite, runAfterSave, runBeforeSave } from './prepare'
import type { Store as StoreTypes } from 'atoma-core'

export class WriteFlow implements RuntimeWrite {
    private runtime: CoreRuntime

    constructor(runtime: CoreRuntime) {
        this.runtime = runtime
    }

    addOne = async <T extends Types.Entity>(handle: StoreHandle<T>, item: Partial<T>, options?: Types.StoreOperationOptions): Promise<T> => {
        const runtime = this.runtime
        const opContext = ensureActionId(options?.opContext)
        const prepared = await prepareForAdd(runtime, handle, item, opContext)

        const result = await this.executeWrite<T>({
            handle,
            opContext,
            writeStrategy: options?.writeStrategy ?? handle.defaultWriteStrategy,
            event: { type: 'add', data: prepared }
        })

        await runAfterSave(handle.hooks, prepared, 'add')
        return result as T
    }

    addMany = async <T extends Types.Entity>(handle: StoreHandle<T>, items: Array<Partial<T>>, options?: Types.StoreOperationOptions): Promise<T[]> => {
        const results: T[] = []
        for (const item of items) {
            results.push(await this.addOne(handle, item, options))
        }
        return results
    }

    updateOne = async <T extends Types.Entity>(handle: StoreHandle<T>, id: EntityId, recipe: (draft: ImmerDraft<T>) => void, options?: Types.StoreOperationOptions): Promise<T> => {
        const runtime = this.runtime
        const opContext = ensureActionId(options?.opContext)
        const base = await resolveBaseForWrite(runtime, handle, id, options)

        const next = produce(base as any, (draft: Draft<T>) => recipe(draft)) as any
        const patched = { ...(next as any), id } as Types.PartialWithId<T>
        const prepared = await prepareForUpdate(runtime, handle, base, patched, opContext)

        const result = await this.executeWrite<T>({
            handle,
            opContext,
            writeStrategy: options?.writeStrategy ?? handle.defaultWriteStrategy,
            event: { type: 'update', data: prepared, base }
        })

        await runAfterSave(handle.hooks, prepared, 'update')
        return result as T
    }

    updateMany = async <T extends Types.Entity>(handle: StoreHandle<T>, items: Array<{ id: EntityId; recipe: (draft: ImmerDraft<T>) => void }>, options?: Types.StoreOperationOptions): Promise<Types.WriteManyResult<T>> => {
        const results: Types.WriteManyResult<T> = new Array(items.length)

        for (let index = 0; index < items.length; index++) {
            const entry = items[index]
            try {
                const value = await this.updateOne(handle, entry.id, entry.recipe, options)
                results[index] = { index, ok: true, value }
            } catch (error) {
                results[index] = { index, ok: false, error }
            }
        }

        return results
    }

    upsertOne = async <T extends Types.Entity>(handle: StoreHandle<T>, item: Types.PartialWithId<T>, options?: Types.StoreOperationOptions & Types.UpsertWriteOptions): Promise<T> => {
        const runtime = this.runtime
        const opContext = ensureActionId(options?.opContext)
        const id = item.id
        const base = handle.jotaiStore.get(handle.atom).get(id) as Types.PartialWithId<T> | undefined
        const merge = options?.merge !== false

        const prepared = await (async () => {
            if (!base) {
                return await prepareForAdd(runtime, handle, item as any, opContext)
            }

            if (merge) {
                return await prepareForUpdate(runtime, handle, base, item, opContext)
            }

            const now = Date.now()
            const createdAt = (base as any).createdAt ?? now
            const candidate: any = {
                ...(item as any),
                id,
                createdAt,
                updatedAt: now
            }

            if (candidate.version === undefined && typeof (base as any).version === 'number') {
                candidate.version = (base as any).version
            }
            if (candidate._etag === undefined && typeof (base as any)._etag === 'string') {
                candidate._etag = (base as any)._etag
            }

            let next = await runBeforeSave(handle.hooks, candidate as any, 'update')
            const processed = await runtime.transform.inbound(handle, next as any, opContext)
            if (!processed) {
                throw new Error('[Atoma] upsertOne: transform returned empty')
            }
            return processed as Types.PartialWithId<T>
        })()

        const result = await this.executeWrite<T>({
            handle,
            opContext,
            writeStrategy: options?.writeStrategy ?? handle.defaultWriteStrategy,
            event: { type: 'upsert', data: prepared, base, upsert: { mode: options?.mode, merge: options?.merge } }
        })

        await runAfterSave(handle.hooks, prepared, base ? 'update' : 'add')
        return result as T
    }

    upsertMany = async <T extends Types.Entity>(handle: StoreHandle<T>, items: Array<Types.PartialWithId<T>>, options?: Types.StoreOperationOptions & Types.UpsertWriteOptions): Promise<Types.WriteManyResult<T>> => {
        const results: Types.WriteManyResult<T> = new Array(items.length)
        for (let index = 0; index < items.length; index++) {
            const entry = items[index]
            try {
                const value = await this.upsertOne(handle, entry, options)
                results[index] = { index, ok: true, value }
            } catch (error) {
                results[index] = { index, ok: false, error }
            }
        }
        return results
    }

    deleteOne = async <T extends Types.Entity>(handle: StoreHandle<T>, id: EntityId, options?: Types.StoreOperationOptions): Promise<boolean> => {
        const runtime = this.runtime
        const opContext = ensureActionId(options?.opContext)
        const base = await resolveBaseForWrite(runtime, handle, id, options)
        await this.executeWrite<T>({
            handle,
            opContext,
            writeStrategy: options?.writeStrategy ?? handle.defaultWriteStrategy,
            event: { type: options?.force ? 'forceRemove' : 'remove', data: { id } as Types.PartialWithId<T>, base }
        })
        return true
    }

    deleteMany = async <T extends Types.Entity>(handle: StoreHandle<T>, ids: EntityId[], options?: Types.StoreOperationOptions): Promise<Types.WriteManyResult<boolean>> => {
        const results: Types.WriteManyResult<boolean> = new Array(ids.length)
        for (let index = 0; index < ids.length; index++) {
            const id = ids[index]
            try {
                const value = await this.deleteOne(handle, id, options)
                results[index] = { index, ok: true, value }
            } catch (error) {
                results[index] = { index, ok: false, error }
            }
        }
        return results
    }

    patches = async <T extends Types.Entity>(handle: StoreHandle<T>, patches: Patch[], inversePatches: Patch[], options?: Types.StoreOperationOptions): Promise<void> => {
        const opContext = ensureActionId(options?.opContext)
        await this.executeWrite<T>({
            handle,
            opContext,
            writeStrategy: options?.writeStrategy ?? handle.defaultWriteStrategy,
            event: { type: 'patches', patches, inversePatches }
        })
    }

    private executeWrite = async <T extends Types.Entity>(args: {
        handle: StoreHandle<T>
        opContext: Types.OperationContext
        writeStrategy?: string
        event: StoreTypes.WriteEvent<T>
    }): Promise<T | void> => {
        const runtime = this.runtime
        const { handle, opContext, event } = args
        const { jotaiStore, atom } = handle

        const before = jotaiStore.get(atom) as Map<EntityId, T>
        const { optimisticState, changedIds, output } = Store.buildOptimisticState({
            baseState: before,
            event
        })

        if (optimisticState !== before && changedIds.size) {
            handle.commitMapUpdateDelta({
                before,
                after: optimisticState,
                changedIds
            })
        }

        const writeOps = await buildWriteOps({
            runtime,
            handle,
            event,
            optimisticState,
            opContext
        })

        if (!writeOps.length) {
            return output
        }

        try {
            const persistResult = await runtime.persistence.persist({
                storeName: String(handle.storeName),
                writeStrategy: args.writeStrategy,
                handle,
                writeOps,
                context: runtime.observe.createContext(handle.storeName)
            })

            const normalizedAck = await applyPersistAck(runtime, handle, event, persistResult)
            const resolvedOutput = resolveOutputFromAck(event, normalizedAck, output as T | undefined)

            return resolvedOutput ?? output
        } catch (error) {
            if (optimisticState !== before && changedIds.size) {
                handle.commitMapUpdateDelta({
                    before: optimisticState,
                    after: before,
                    changedIds
                })
            }
            throw error
        }
    }
}
