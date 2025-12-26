import type { DataSource, EntityManager } from 'typeorm'
import type { AtomaChange, ISyncAdapter, IdempotencyResult } from '../../sync/types'
import { throwError } from '../../error'
import { AtomaTypeormAdapter } from './TypeormAdapter'

type TypeormExecutor =
    | Pick<DataSource, 'createQueryBuilder' | 'query'>
    | Pick<EntityManager, 'createQueryBuilder' | 'query'>

type Options = {
    tables?: {
        changes?: string
        idempotency?: string
    }
}

function assertSafeTableName(name: string) {
    if (!/^[a-zA-Z0-9_]+$/.test(name)) {
        throwError('INVALID_REQUEST', `Invalid table name: ${name}`, { kind: 'validation', path: 'tables' })
    }
}

export class AtomaTypeormSyncAdapter implements ISyncAdapter {
    private readonly changesTable: string
    private readonly idempotencyTable: string

    constructor(
        private readonly executor: TypeormExecutor,
        options: Options = {}
    ) {
        this.changesTable = options.tables?.changes ?? 'atoma_changes'
        this.idempotencyTable = options.tables?.idempotency ?? 'atoma_idempotency'
        assertSafeTableName(this.changesTable)
        assertSafeTableName(this.idempotencyTable)
    }

    private resolveExecutor(tx?: unknown): TypeormExecutor {
        const e = tx as any
        if (e && typeof e.createQueryBuilder === 'function' && typeof e.query === 'function') return e as TypeormExecutor
        return this.executor
    }

    async getIdempotency(key: string, tx?: unknown): Promise<IdempotencyResult> {
        const executor = this.resolveExecutor(tx)
        const row = await executor
            .createQueryBuilder()
            .select([
                'i.status as status',
                'i.bodyJson as bodyJson',
                'i.expiresAt as expiresAt'
            ])
            .from(this.idempotencyTable, 'i')
            .where('i.idempotencyKey = :key', { key })
            .getRawOne()

        if (!row) return { hit: false }

        const expiresAt = typeof row.expiresAt === 'number' ? row.expiresAt : Number(row.expiresAt)
        if (Number.isFinite(expiresAt) && expiresAt > 0 && Date.now() > expiresAt) {
            return { hit: false }
        }

        const status = typeof row.status === 'number' ? row.status : Number(row.status)
        if (!Number.isFinite(status)) return { hit: false }

        const body = (() => {
            try {
                return row.bodyJson ? JSON.parse(row.bodyJson) : undefined
            } catch {
                return undefined
            }
        })()

        return { hit: true, status, body }
    }

    async putIdempotency(key: string, value: { status: number; body: unknown }, ttlMs?: number, tx?: unknown): Promise<void> {
        const executor = this.resolveExecutor(tx)
        const now = Date.now()
        const expiresAt = now + Math.max(0, Math.floor(ttlMs ?? 0))

        await executor
            .createQueryBuilder()
            .insert()
            .into(this.idempotencyTable)
            .values({
                idempotencyKey: key,
                status: value.status,
                bodyJson: JSON.stringify(value.body ?? null),
                createdAt: now,
                expiresAt
            } as any)
            .orIgnore()
            .execute()
    }

    async appendChange(change: Omit<AtomaChange, 'cursor'>, tx?: unknown): Promise<AtomaChange> {
        const executor = this.resolveExecutor(tx)
        const inserted = await executor
            .createQueryBuilder()
            .insert()
            .into(this.changesTable)
            .values({
                resource: change.resource,
                id: change.id,
                kind: change.kind,
                serverVersion: change.serverVersion,
                changedAt: change.changedAt
            } as any)
            .execute()

        let cursor = (() => {
            const fromMap = Array.isArray(inserted.generatedMaps) && inserted.generatedMaps[0]
                ? (inserted.generatedMaps[0] as any).cursor
                : undefined
            if (typeof fromMap === 'number' && Number.isFinite(fromMap)) return fromMap
            if (typeof fromMap === 'string' && fromMap) {
                const n = Number(fromMap)
                if (Number.isFinite(n)) return Math.floor(n)
            }

            const id = Array.isArray(inserted.identifiers) && inserted.identifiers[0]
                ? (inserted.identifiers[0] as any).cursor
                : undefined
            if (typeof id === 'number' && Number.isFinite(id)) return id
            if (typeof id === 'string' && id) {
                const n = Number(id)
                if (Number.isFinite(n)) return Math.floor(n)
            }

            const raw = (inserted as any)?.raw
            const rawCandidate = (raw && typeof raw === 'object' && !Array.isArray(raw))
                ? ((raw as any).lastID ?? (raw as any).insertId ?? (raw as any).lastId ?? (raw as any).cursor)
                : raw
            if (typeof rawCandidate === 'number' && Number.isFinite(rawCandidate)) return rawCandidate
            if (typeof rawCandidate === 'string' && rawCandidate) {
                const n = Number(rawCandidate)
                if (Number.isFinite(n)) return Math.floor(n)
            }

            return NaN
        })()

        if (!Number.isFinite(cursor)) {
            try {
                const rows = await executor.query('SELECT last_insert_rowid() as cursor')
                const row = Array.isArray(rows) ? rows[0] : rows
                const n = Number((row as any)?.cursor)
                if (Number.isFinite(n)) cursor = Math.floor(n)
            } catch {}
        }

        if (!Number.isFinite(cursor)) {
            throwError('INTERNAL', 'Failed to read inserted cursor', { kind: 'internal' })
        }

        return { ...change, cursor }
    }

    async pullChanges(cursor: number, limit: number): Promise<AtomaChange[]> {
        const rows = await this.executor
            .createQueryBuilder()
            .select([
                'c.cursor as cursor',
                'c.resource as resource',
                'c.id as id',
                'c.kind as kind',
                'c.serverVersion as serverVersion',
                'c.changedAt as changedAt'
            ])
            .from(this.changesTable, 'c')
            .where('c.cursor > :cursor', { cursor })
            .orderBy('c.cursor', 'ASC')
            .limit(limit)
            .getRawMany()

        return rows.map((r: any) => ({
            cursor: Number(r.cursor),
            resource: String(r.resource),
            id: String(r.id),
            kind: r.kind as any,
            serverVersion: Number(r.serverVersion),
            changedAt: Number(r.changedAt)
        }))
    }

    async waitForChanges(cursor: number, timeoutMs: number): Promise<AtomaChange[]> {
        const deadline = Date.now() + Math.max(0, timeoutMs)
        while (Date.now() < deadline) {
            const changes = await this.pullChanges(cursor, 200)
            if (changes.length) return changes
            await new Promise(r => setTimeout(r, 250))
        }
        return []
    }
}

export function createTypeormServerAdapter(args: {
    dataSource: DataSource
    tables?: { changes?: string; idempotency?: string }
}) {
    const orm = new AtomaTypeormAdapter(args.dataSource)
    const sync = new AtomaTypeormSyncAdapter(args.dataSource, { tables: args.tables })
    return { orm, sync }
}
