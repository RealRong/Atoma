import type { Entity, LifecycleHooks, OperationContext, PartialWithId, StoreOperationOptions } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { mergeForUpdate, initBaseObject } from 'atoma-core/store'
import { normalizeOperationContext } from 'atoma-core/operation'
import type { StoreHandle } from 'atoma-types/runtime'
import type { CoreRuntime } from 'atoma-types/runtime'

export function ensureActionId(opContext?: OperationContext): OperationContext {
    return normalizeOperationContext(opContext)
}

export async function prepareForAdd<T extends Entity>(runtime: CoreRuntime, handle: StoreHandle<T>, item: Partial<T>, opContext?: OperationContext): Promise<PartialWithId<T>> {
    let initedObj = initBaseObject<T>(item, handle.config.idGenerator)
    initedObj = await runBeforeSave(handle.config.hooks, initedObj, 'add')
    const processed = await runtime.transform.inbound(handle, initedObj as T, opContext)
    return requireProcessed(processed as PartialWithId<T> | undefined, 'prepareForAdd')
}

export async function prepareForUpdate<T extends Entity>(runtime: CoreRuntime, handle: StoreHandle<T>, base: PartialWithId<T>, patch: PartialWithId<T>, opContext?: OperationContext): Promise<PartialWithId<T>> {
    let merged = mergeForUpdate(base, patch)
    merged = await runBeforeSave(handle.config.hooks, merged, 'update')
    const processed = await runtime.transform.inbound(handle, merged as T, opContext)
    return requireProcessed(processed as PartialWithId<T> | undefined, 'prepareForUpdate')
}

export async function resolveBaseForWrite<T extends Entity>(runtime: CoreRuntime, handle: StoreHandle<T>, id: EntityId, options?: StoreOperationOptions): Promise<PartialWithId<T>> {
    const cached = handle.state.getSnapshot().get(id) as T | undefined
    if (cached) return cached as PartialWithId<T>

    const writePolicy = runtime.strategy.resolveWritePolicy(options?.writeStrategy ?? handle.config.defaultWriteStrategy)
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
    return processed as PartialWithId<T>
}

export async function runBeforeSave<T>(hooks: LifecycleHooks<T> | undefined, item: PartialWithId<T>, action: 'add' | 'update'): Promise<PartialWithId<T>> {
    if (hooks?.beforeSave) {
        return await hooks.beforeSave({ action, item })
    }
    return item
}

export async function runAfterSave<T>(hooks: LifecycleHooks<T> | undefined, item: PartialWithId<T>, action: 'add' | 'update'): Promise<void> {
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
