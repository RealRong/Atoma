import type { Entity, PartialWithId, StoreOperationOptions, ActionContext } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import type { Runtime, StoreHandle } from 'atoma-types/runtime'
import { ensureWriteItemMeta, createIdempotencyKey } from 'atoma-shared'
import type { WriteScope } from '../contracts'

export async function requireOutbound<T extends Entity>({
    runtime,
    scope,
    value
}: {
    runtime: Runtime
    scope: WriteScope<T>
    value: T
}): Promise<T> {
    const outbound = await runtime.processor.outbound(
        scope.handle,
        value,
        scope.context
    )
    if (outbound === undefined) {
        throw new Error('[Atoma] processor returned empty for outbound write')
    }
    return outbound
}

export function createMeta(now: () => number) {
    return ensureWriteItemMeta({
        meta: {
            idempotencyKey: createIdempotencyKey({ now }),
            clientTimeMs: now()
        },
        now
    })
}

export function requireUpdatedEntity<T extends Entity>(value: unknown, id: string): T {
    if (!value || typeof value !== 'object') {
        throw new Error('[Atoma] update: updater must return entity object')
    }

    if ((value as PartialWithId<T>).id !== id) {
        throw new Error(`[Atoma] update: updater must keep id unchanged (id=${String(id)})`)
    }

    return value as T
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

    const consistency = runtime.execution.getConsistency()
    const canFetchBase = consistency.base === 'fetch'
    if (!canFetchBase) {
        throw new Error(`[Atoma] write: 缓存缺失且当前写入模式禁止补读，请先 fetch 再写入（id=${String(id)}）`)
    }
    if (!runtime.execution.hasExecutor('query')) {
        throw new Error(`[Atoma] write: 缓存缺失且未安装远端 query 执行器（id=${String(id)}）`)
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

    const processed = await runtime.processor.writeback(handle, fetched, context)
    if (!processed) {
        throw new Error(`Item with id ${id} not found`)
    }
    return processed as PartialWithId<T>
}

export function requireProcessed<T>(value: T | undefined, tag: string): T {
    if (value === undefined) {
        throw new Error(`[Atoma] ${tag}: processor returned empty`)
    }
    return value
}
