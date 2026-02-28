import type { AtomaError } from '../error'
import type { ChangeKind, PageInfo, Query, SortRule, WriteOptions } from 'atoma-types/protocol'

export interface QueryResult<T = any> {
    data: T[]
    pageInfo?: PageInfo
}

export interface QueryResultOne<T = any> {
    data?: T
    /**
     * Adapter 错误必须使用 AtomaError（带 brand），以保证对外错误结构可控且不泄露内部异常。
     * 不再接受裸 StandardError 对象。
     */
    error?: AtomaError
    transactionApplied?: boolean
}

export type OrmTransactionContext = unknown

export type OrmTransactionArgs = {
    orm: IOrmAdapter
    tx: OrmTransactionContext
}

export interface IOrmAdapter {
    findMany(resource: string, query: Query): Promise<QueryResult>
    batchFindMany?(requests: Array<{ resource: string; query: Query }>): Promise<QueryResult[]>
    transaction<T>(fn: (args: OrmTransactionArgs) => Promise<T>): Promise<T>
    create?(resource: string, data: any, options?: WriteOptions): Promise<QueryResultOne>
    update?(
        resource: string,
        item: { id: any; data: any; baseVersion?: number },
        options?: WriteOptions
    ): Promise<QueryResultOne>
    upsert?(
        resource: string,
        item: { id: any; data: any; expectedVersion?: number; conflict?: 'cas' | 'lww'; apply?: 'merge' | 'replace' },
        options?: WriteOptions
    ): Promise<QueryResultOne>
    delete?(resource: string, whereOrId: any, options?: WriteOptions): Promise<QueryResultOne>
}

export interface OrmAdapterOptions {
    /** 主键/唯一 tie-breaker 字段名，默认 'id' */
    idField?: string
    /** 默认排序（若请求未提供 sort）；若未提供则默认按 idField asc */
    defaultSort?: SortRule[]
}

export type AtomaChange = {
    cursor: number
    resource: string
    id: string
    kind: ChangeKind
    serverVersion: number
    changedAt: number
}

export type IdempotencyHit = {
    hit: true
    status: number
    body: unknown
}

export type IdempotencyMiss = {
    hit: false
}

export type IdempotencyResult = IdempotencyHit | IdempotencyMiss

export type IdempotencyClaimAcquired = {
    acquired: true
}

export type IdempotencyClaimRejected = {
    acquired: false
    status?: number
    body?: unknown
}

export type IdempotencyClaimResult = IdempotencyClaimAcquired | IdempotencyClaimRejected

export type SyncTransactionContext = unknown

export interface ISyncAdapter {
    getIdempotency: (key: string, tx?: SyncTransactionContext) => Promise<IdempotencyResult>
    claimIdempotency: (
        key: string,
        value: { status: number; body: unknown },
        ttlMs?: number,
        tx?: SyncTransactionContext
    ) => Promise<IdempotencyClaimResult>
    putIdempotency: (key: string, value: { status: number; body: unknown }, ttlMs?: number, tx?: SyncTransactionContext) => Promise<void>
    appendChange: (change: Omit<AtomaChange, 'cursor'>, tx?: SyncTransactionContext) => Promise<AtomaChange>
    pullChangesByResource: (args: {
        resource: string
        cursor: number
        limit: number
    }) => Promise<AtomaChange[]>
    waitForResourceChanges: (args: {
        resources?: string[]
        afterCursorByResource?: Record<string, number>
        timeoutMs: number
    }) => Promise<Array<{
        resource: string
        cursor: number
    }>>
}
