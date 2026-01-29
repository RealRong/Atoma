/**
 * RuntimeIoLocal: Local-only implementation of RuntimeIo.
 * - Used when backend is not available (ephemeral/local-only mode).
 * - Query operations use in-memory executeLocalQuery.
 * - Write/executeOps operations throw errors.
 */
import type { Entity, RuntimeIo } from '#core'
import type { StoreHandle } from '#core/store/internals/handleTypes'
import type { Query } from '#protocol'
import { executeLocalQuery } from '#core/query'
import type { EntityId } from '#protocol'

export function createLocalRuntimeIo(): RuntimeIo {
    const executeOps: RuntimeIo['executeOps'] = async () => {
        throw new Error('[Atoma] local-only 模式不支持 ops 执行')
    }

    const query: RuntimeIo['query'] = async <T extends Entity>(
        handle: StoreHandle<T>,
        query: Query
    ) => {
        const map = handle.jotaiStore.get(handle.atom) as Map<EntityId, T>
        const items = Array.from(map.values()) as T[]
        return executeLocalQuery(items as any, query as any)
    }

    const write: RuntimeIo['write'] = async () => {
        throw new Error('[Atoma] local-only 模式不支持 io.write')
    }

    return { executeOps, query, write }
}
