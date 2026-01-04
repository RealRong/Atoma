import type { AtomaError } from '../error'
import type { ChangeKind, CursorToken, OrderByRule, PageInfo, QueryParams, WriteOptions } from '#protocol'

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

export interface QueryResultMany<T = any> {
    /**
     * 与输入 items 的 index 一一对应（resultsByIndex.length 必须等于 items.length）。
     */
    resultsByIndex: Array<
        | { ok: true; data?: T }
        | {
            ok: false
            /**
             * errors 同样要求 AtomaError。
             */
            error: AtomaError
        }
    >
    transactionApplied?: boolean
}

export type OrmTransactionContext = unknown

export type OrmTransactionArgs = {
    orm: IOrmAdapter
    tx: OrmTransactionContext
}

export interface IOrmAdapter {
    findMany(resource: string, params: QueryParams): Promise<QueryResult>
    batchFindMany?(requests: Array<{ resource: string; params: QueryParams }>): Promise<QueryResult[]>
    transaction<T>(fn: (args: OrmTransactionArgs) => Promise<T>): Promise<T>
    create?(resource: string, data: any, options?: WriteOptions): Promise<QueryResultOne>
    update?(
        resource: string,
        item: { id: any; data: any; baseVersion?: number; timestamp?: number },
        options?: WriteOptions
    ): Promise<QueryResultOne>
    upsert?(
        resource: string,
        item: { id: any; data: any; baseVersion?: number; timestamp?: number; mode?: 'strict' | 'loose'; merge?: boolean },
        options?: WriteOptions
    ): Promise<QueryResultOne>
    delete?(resource: string, whereOrId: any, options?: WriteOptions): Promise<QueryResultOne>
    bulkCreate?(resource: string, items: any[], options?: WriteOptions): Promise<QueryResultMany>
    bulkUpdate?(resource: string, items: Array<{ id: any; data: any; baseVersion?: number; timestamp?: number }>, options?: WriteOptions): Promise<QueryResultMany>
    bulkUpsert?(
        resource: string,
        items: Array<{ id: any; data: any; baseVersion?: number; timestamp?: number; mode?: 'strict' | 'loose'; merge?: boolean }>,
        options?: WriteOptions
    ): Promise<QueryResultMany>
    bulkDelete?(resource: string, items: Array<{ id: any; baseVersion?: number }>, options?: WriteOptions): Promise<QueryResultMany>
}

export interface OrmAdapterOptions {
    /** 主键/唯一 tie-breaker 字段名，默认 'id' */
    idField?: string
    /** 默认排序（若请求未提供 orderBy）；若未提供则默认按 idField asc */
    defaultOrderBy?: OrderByRule[]
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

export type SyncTransactionContext = unknown

export interface ISyncAdapter {
    getIdempotency: (key: string, tx?: SyncTransactionContext) => Promise<IdempotencyResult>
    putIdempotency: (key: string, value: { status: number; body: unknown }, ttlMs?: number, tx?: SyncTransactionContext) => Promise<void>
    appendChange: (change: Omit<AtomaChange, 'cursor'>, tx?: SyncTransactionContext) => Promise<AtomaChange>
    getLatestCursor: () => Promise<number>
    pullChanges: (cursor: number, limit: number) => Promise<AtomaChange[]>
    waitForChanges: (cursor: number, timeoutMs: number) => Promise<AtomaChange[]>
}

export type { ChangeKind } from '#protocol'
export type { CursorToken, OrderByRule, QueryParams, WriteOptions } from '#protocol'
export type { StandardError } from '#protocol'
