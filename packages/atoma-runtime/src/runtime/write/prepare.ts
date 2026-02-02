import type { Types } from 'atoma-core'
import type { EntityId } from 'atoma-protocol'
import { Operation, Store } from 'atoma-core'
import type { StoreHandle } from '../../types/runtimeTypes'
import type { CoreRuntime } from '../../types/runtimeTypes'

export function ensureActionId(opContext?: Types.OperationContext): Types.OperationContext {
    return Operation.normalizeOperationContext(opContext)
}

export async function prepareForAdd<T extends Types.Entity>(runtime: CoreRuntime, handle: StoreHandle<T>, item: Partial<T>, opContext?: Types.OperationContext): Promise<Types.PartialWithId<T>> {
    let initedObj = Store.StoreWriteUtils.initBaseObject<T>(item, handle.idGenerator)
    initedObj = await runBeforeSave(handle.hooks, initedObj, 'add')
    const processed = await runtime.transform.inbound(handle, initedObj as T, opContext)
    return requireProcessed(processed as Types.PartialWithId<T> | undefined, 'prepareForAdd')
}

export async function prepareForUpdate<T extends Types.Entity>(runtime: CoreRuntime, handle: StoreHandle<T>, base: Types.PartialWithId<T>, patch: Types.PartialWithId<T>, opContext?: Types.OperationContext): Promise<Types.PartialWithId<T>> {
    let merged = Store.StoreWriteUtils.mergeForUpdate(base, patch)
    merged = await runBeforeSave(handle.hooks, merged, 'update')
    const processed = await runtime.transform.inbound(handle, merged as T, opContext)
    return requireProcessed(processed as Types.PartialWithId<T> | undefined, 'prepareForUpdate')
}

export async function resolveBaseForWrite<T extends Types.Entity>(runtime: CoreRuntime, handle: StoreHandle<T>, id: EntityId, options?: Types.StoreOperationOptions): Promise<Types.PartialWithId<T>> {
    const { jotaiStore, atom } = handle
    const cached = jotaiStore.get(atom).get(id) as T | undefined
    if (cached) return cached as Types.PartialWithId<T>

    const writePolicy = runtime.persistence.resolveWritePolicy(options?.writeStrategy ?? handle.defaultWriteStrategy)
    const allowImplicitFetchForWrite = writePolicy.implicitFetch !== false
    if (!allowImplicitFetchForWrite) {
        throw new Error(`[Atoma] write: 缓存缺失且当前写入模式禁止补读，请先 fetch 再写入（id=${String(id)}）`)
    }

    const { data } = await runtime.io.query(handle, {
        filter: { op: 'eq', field: 'id', value: id },
        page: { mode: 'offset', limit: 1, offset: 0, includeTotal: false }
    })
    const one = data[0]
    const fetched = one !== undefined ? (one as T) : undefined
    if (!fetched) {
        throw new Error(`Item with id ${id} not found`)
    }

    const processed = await runtime.transform.writeback(handle, fetched, options?.opContext)
    if (!processed) {
        throw new Error(`Item with id ${id} not found`)
    }
    return processed as Types.PartialWithId<T>
}

export async function runBeforeSave<T>(hooks: Types.LifecycleHooks<T> | undefined, item: Types.PartialWithId<T>, action: 'add' | 'update'): Promise<Types.PartialWithId<T>> {
    if (hooks?.beforeSave) {
        return await hooks.beforeSave({ action, item })
    }
    return item
}

export async function runAfterSave<T>(hooks: Types.LifecycleHooks<T> | undefined, item: Types.PartialWithId<T>, action: 'add' | 'update'): Promise<void> {
    if (hooks?.afterSave) {
        await hooks.afterSave({ action, item })
    }
}

function requireProcessed<T>(value: T | undefined, tag: string): T {
    if (value === undefined) {
        throw new Error(`[Atoma] ${tag}: transform returned empty`)
    }
    return value
}
