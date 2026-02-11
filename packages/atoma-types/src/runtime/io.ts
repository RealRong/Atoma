import type { Entity, Query } from '../core'
import type { StoreHandle } from './handle'

export type Io = Readonly<{
    query: <T extends Entity>(
        handle: StoreHandle<T>,
        query: Query,
        signal?: AbortSignal
    ) => Promise<{ data: unknown[]; pageInfo?: unknown }>
}>
