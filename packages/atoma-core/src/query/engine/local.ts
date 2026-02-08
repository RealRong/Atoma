import type { Entity, Query } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import type { StoreIndexes } from '../../indexes/StoreIndexes'
import type { ExecuteOptions } from './LocalQueryExecutor'
import { LocalQueryExecutor } from './LocalQueryExecutor'
import { evaluateWithIndexes as evaluateWithIndexesInternal } from './indexEvaluation'

export function executeLocalQuery<T extends object>(
    items: T[],
    query: Query,
    opts?: ExecuteOptions
) {
    return new LocalQueryExecutor(items, query, opts).execute()
}

export function evaluateWithIndexes<T extends Entity>(params: {
    mapRef: Map<EntityId, T>
    query: Query<T>
    indexes: StoreIndexes<T> | null
    matcher?: ExecuteOptions['matcher']
    emit?: (type: string, payload: unknown) => void
}) {
    return evaluateWithIndexesInternal(params)
}
