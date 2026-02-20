import type { Entity, ActionContext, PartialWithId, StoreOperationOptions } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import type { Runtime, StoreHandle } from 'atoma-types/runtime'

export async function prepareCreateInput<T extends Entity>(
    runtime: Runtime,
    handle: StoreHandle<T>,
    item: Partial<T>,
    context?: ActionContext
): Promise<PartialWithId<T>> {
    const initialized = runtime.engine.mutation.create<T>(item, handle.config.idGenerator)
    const processed = await runtime.transform.inbound(handle, initialized as T, context)
    return requireProcessed(processed as PartialWithId<T> | undefined, 'prepareCreateInput')
}

export async function prepareUpdateInput<T extends Entity>(
    runtime: Runtime,
    handle: StoreHandle<T>,
    base: PartialWithId<T>,
    patch: PartialWithId<T>,
    context?: ActionContext
): Promise<PartialWithId<T>> {
    const mergedInput = runtime.engine.mutation.merge(base, patch)
    const processed = await runtime.transform.inbound(handle, mergedInput as T, context)
    return requireProcessed(processed as PartialWithId<T> | undefined, 'prepareUpdateInput')
}

export async function prepareUpsertInput<T extends Entity>(
    runtime: Runtime,
    handle: StoreHandle<T>,
    item: PartialWithId<T>,
    context?: ActionContext
): Promise<PartialWithId<T>> {
    const candidate = {
        ...(item as Record<string, unknown>),
        id: item.id
    } as PartialWithId<T>
    const processed = await runtime.transform.inbound(handle, candidate as T, context)
    return requireProcessed(processed as PartialWithId<T> | undefined, 'prepareUpsertInput')
}

export async function resolveWriteBase<T extends Entity>(
    runtime: Runtime,
    handle: StoreHandle<T>,
    id: EntityId,
    options?: StoreOperationOptions,
    context?: ActionContext
): Promise<PartialWithId<T>> {
    const cached = handle.state.snapshot().get(id) as T | undefined
    if (cached) return cached as PartialWithId<T>

    const consistency = runtime.execution.resolveConsistency(handle, options)
    const canFetchBase = consistency.base === 'fetch'
    if (!canFetchBase) {
        throw new Error(`[Atoma] write: 缓存缺失且当前写入模式禁止补读，请先 fetch 再写入（id=${String(id)}）`)
    }

    const { data } = await runtime.execution.query(
        {
            handle,
            query: {
                filter: { op: 'eq', field: 'id', value: id },
                page: { mode: 'offset', limit: 1, offset: 0, includeTotal: false }
            }
        },
        options
    )
    const first = data[0]
    const fetched = first !== undefined ? (first as T) : undefined
    if (!fetched) {
        throw new Error(`Item with id ${id} not found`)
    }

    const processed = await runtime.transform.writeback(handle, fetched, context)
    if (!processed) {
        throw new Error(`Item with id ${id} not found`)
    }
    return processed as PartialWithId<T>
}

function requireProcessed<T>(value: T | undefined, tag: string): T {
    if (value === undefined) {
        throw new Error(`[Atoma] ${tag}: transform returned empty`)
    }
    return value
}
