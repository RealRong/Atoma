import type { ChangeKind } from '#protocol'

export type AtomaChange = {
    cursor: number
    resource: string
    id: string
    kind: ChangeKind
    serverVersion: number
    changedAt: number
}

export type { ChangeKind } from '#protocol'

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
    pullChanges: (cursor: number, limit: number) => Promise<AtomaChange[]>
    waitForChanges: (cursor: number, timeoutMs: number) => Promise<AtomaChange[]>
}
