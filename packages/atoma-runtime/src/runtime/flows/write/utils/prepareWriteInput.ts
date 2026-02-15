import type { Entity, LifecycleHooks, OperationContext, PartialWithId, StoreOperationOptions } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import type { Runtime, StoreHandle } from 'atoma-types/runtime'

export async function prepareCreateInput<T extends Entity>(
    runtime: Runtime,
    handle: StoreHandle<T>,
    item: Partial<T>,
    opContext?: OperationContext
): Promise<PartialWithId<T>> {
    let initialized = runtime.engine.mutation.init<T>(item, handle.config.idGenerator)
    initialized = await runBeforeSave(handle.config.hooks, initialized, 'add')
    const processed = await runtime.transform.inbound(handle, initialized as T, opContext)
    return requireProcessed(processed as PartialWithId<T> | undefined, 'prepareCreateInput')
}

export async function prepareUpdateInput<T extends Entity>(
    runtime: Runtime,
    handle: StoreHandle<T>,
    base: PartialWithId<T>,
    patch: PartialWithId<T>,
    opContext?: OperationContext
): Promise<PartialWithId<T>> {
    let mergedInput = runtime.engine.mutation.merge(base, patch)
    mergedInput = await runBeforeSave(handle.config.hooks, mergedInput, 'update')
    const processed = await runtime.transform.inbound(handle, mergedInput as T, opContext)
    return requireProcessed(processed as PartialWithId<T> | undefined, 'prepareUpdateInput')
}

export async function resolveWriteBase<T extends Entity>(
    runtime: Runtime,
    handle: StoreHandle<T>,
    id: EntityId,
    options?: StoreOperationOptions
): Promise<PartialWithId<T>> {
    const cached = handle.state.getSnapshot().get(id) as T | undefined
    if (cached) return cached as PartialWithId<T>

    const consistency = runtime.execution.resolveConsistency(options?.route ?? handle.config.defaultRoute)
    const canFetchBase = consistency.base === 'fetch'
    if (!canFetchBase) {
        throw new Error(`[Atoma] write: 缓存缺失且当前写入模式禁止补读，请先 fetch 再写入（id=${String(id)}）`)
    }

    const route = options?.route ?? handle.config.defaultRoute
    const { data } = await runtime.execution.query(
        {
            handle,
            query: {
                filter: { op: 'eq', field: 'id', value: id },
                page: { mode: 'offset', limit: 1, offset: 0, includeTotal: false }
            }
        },
        {
            ...(route !== undefined ? { route } : {}),
            ...(options?.signal ? { signal: options.signal } : {})
        }
    )
    const first = data[0]
    const fetched = first !== undefined ? (first as T) : undefined
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
