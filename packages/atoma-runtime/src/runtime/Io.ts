import type { Entity, Query } from 'atoma-core'
import { executeLocalQuery } from 'atoma-core'
import type { EntityId } from 'atoma-protocol'
import type { RuntimeIo, StoreHandle } from '../types/runtimeTypes'

export class LocalIo implements RuntimeIo {
    executeOps: RuntimeIo['executeOps'] = async () => {
        throw new Error('[Atoma] local-only 模式不支持 ops 执行')
    }

    query: RuntimeIo['query'] = async <T extends Entity>(
        handle: StoreHandle<T>,
        query: Query
    ) => {
        const map = handle.jotaiStore.get(handle.atom) as Map<EntityId, T>
        const items = Array.from(map.values()) as T[]
        return executeLocalQuery(items as any, query as any)
    }
}
