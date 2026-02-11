import type { Entity, Query } from '../core'
import type { Operation, OperationResult } from '../protocol'
import type { StoreHandle } from './handle'

export type Io = Readonly<{
    executeOps: (args: { ops: Operation[]; signal?: AbortSignal }) => Promise<OperationResult[]>
    query: <T extends Entity>(
        handle: StoreHandle<T>,
        query: Query,
        signal?: AbortSignal
    ) => Promise<{ data: unknown[]; pageInfo?: unknown }>
}>
