import type { AtomaChange, ISyncAdapter, IdempotencyClaimResult, IdempotencyResult } from '../ports'
import { AtomaPrismaAdapter } from './PrismaAdapter'

type PrismaClientLike = Record<string, any> & {
    $transaction?: any
}

type Options = {
    /**
     * Prisma 版本的“零反射”做法：要求用户在 schema.prisma 中显式定义这两个 model：
     * - atoma_changes
     * - atoma_idempotency
     *
     * 不考虑兼容性：先固定 model 名；如需自定义表名/多租户分表，后续再扩展。
     */
    models?: {
        changes?: string // default: 'atoma_changes'
        idempotency?: string // default: 'atoma_idempotency'
    }
}

export class AtomaPrismaSyncAdapter implements ISyncAdapter {
    private readonly changesModel: string
    private readonly idempotencyModel: string

    constructor(
        private readonly client: PrismaClientLike,
        options: Options = {}
    ) {
        this.changesModel = options.models?.changes ?? 'atoma_changes'
        this.idempotencyModel = options.models?.idempotency ?? 'atoma_idempotency'
    }

    private changes(client: PrismaClientLike) {
        return (client as any)[this.changesModel]
    }

    private idempotency(client: PrismaClientLike) {
        return (client as any)[this.idempotencyModel]
    }

    private clientFor(tx?: unknown): PrismaClientLike {
        const c = tx as any
        return (c && typeof c === 'object') ? (c as PrismaClientLike) : this.client
    }

    private parseStoredBody(bodyJson: unknown): unknown {
        if (typeof bodyJson !== 'string' || !bodyJson) return undefined
        try {
            return JSON.parse(bodyJson)
        } catch {
            return undefined
        }
    }

    private normalizeExpiry(expiresAt: unknown): number | undefined {
        const value = typeof expiresAt === 'number' ? expiresAt : Number(expiresAt)
        if (!Number.isFinite(value)) return undefined
        return Math.floor(value)
    }

    private normalizeStatus(status: unknown): number | undefined {
        const value = typeof status === 'number' ? status : Number(status)
        if (!Number.isFinite(value)) return undefined
        return Math.floor(value)
    }

    private isExpired(expiresAt: unknown, now: number): boolean {
        const expiry = this.normalizeExpiry(expiresAt)
        return typeof expiry === 'number' && expiry > 0 && now > expiry
    }

    private readClaimExisting(row: any): IdempotencyClaimResult {
        const status = this.normalizeStatus(row?.status)
        const body = this.parseStoredBody(row?.bodyJson)
        return {
            acquired: false,
            ...(typeof status === 'number' ? { status } : {}),
            ...(body !== undefined ? { body } : {})
        }
    }

    private isUniqueViolation(err: any) {
        return Boolean(err && typeof err === 'object' && (err as any).code === 'P2002')
    }

    async getIdempotency(key: string, tx?: unknown): Promise<IdempotencyResult> {
        const client = this.clientFor(tx)
        const model = this.idempotency(client)
        if (!model?.findUnique) return { hit: false }

        const row = await model.findUnique({ where: { idempotencyKey: key } })
        if (!row) return { hit: false }

        const now = Date.now()
        if (this.isExpired(row.expiresAt, now)) {
            return { hit: false }
        }

        const status = this.normalizeStatus(row.status)
        if (typeof status !== 'number') return { hit: false }
        const body = this.parseStoredBody(row.bodyJson)

        return { hit: true, status, body }
    }

    async claimIdempotency(
        key: string,
        value: { status: number; body: unknown },
        ttlMs?: number,
        tx?: unknown
    ): Promise<IdempotencyClaimResult> {
        const client = this.clientFor(tx)
        const model = this.idempotency(client)
        if (!model?.findUnique || !model?.create) {
            return { acquired: true }
        }

        const now = Date.now()
        const expiresAt = now + Math.max(0, Math.floor(ttlMs ?? 0))
        const data = {
            idempotencyKey: key,
            status: value.status,
            bodyJson: JSON.stringify(value.body ?? null),
            createdAt: now,
            expiresAt
        }

        const existing = await model.findUnique({ where: { idempotencyKey: key } })
        if (existing) {
            if (!this.isExpired(existing.expiresAt, now)) {
                return this.readClaimExisting(existing)
            }
            if (typeof model.deleteMany === 'function') {
                await model.deleteMany({
                    where: {
                        idempotencyKey: key,
                        expiresAt: { lte: now }
                    }
                })
            }
        }

        try {
            await model.create({ data })
            return { acquired: true }
        } catch (err) {
            if (!this.isUniqueViolation(err)) throw err
        }

        const winner = await model.findUnique({ where: { idempotencyKey: key } })
        if (!winner) return { acquired: false }
        return this.readClaimExisting(winner)
    }

    async putIdempotency(key: string, value: { status: number; body: unknown }, ttlMs?: number, tx?: unknown): Promise<void> {
        const client = this.clientFor(tx)
        const model = this.idempotency(client)
        if (!model) return

        const now = Date.now()
        const expiresAt = now + Math.max(0, Math.floor(ttlMs ?? 0))

        const data = {
            idempotencyKey: key,
            status: value.status,
            bodyJson: JSON.stringify(value.body ?? null),
            createdAt: now,
            expiresAt
        }

        const upsert = (model as any)?.upsert
        if (typeof upsert === 'function') {
            await upsert({
                where: { idempotencyKey: key },
                create: data,
                update: data
            })
            return
        }

        if (typeof model.update === 'function') {
            try {
                await model.update({
                    where: { idempotencyKey: key },
                    data
                })
                return
            } catch (err) {
                const code = (err as any)?.code
                if (code !== 'P2025') throw err
            }
        }

        if (typeof model.create === 'function') {
            try {
                await model.create({ data })
                return
            } catch (err) {
                if (!this.isUniqueViolation(err)) throw err
            }
        }

        if (typeof model.update === 'function') {
            await model.update({
                where: { idempotencyKey: key },
                data
            })
        }
    }

    async appendChange(change: Omit<AtomaChange, 'cursor'>, tx?: unknown): Promise<AtomaChange> {
        const client = this.clientFor(tx)
        const model = this.changes(client)
        if (!model?.create) {
            throw new Error('Prisma changes model is missing. Define `model atoma_changes` in schema.prisma.')
        }

        const row = await model.create({
            data: {
                resource: change.resource,
                id: change.id,
                kind: change.kind,
                serverVersion: change.serverVersion,
                changedAt: change.changedAt
            }
        })

        return {
            cursor: Number(row.cursor),
            resource: String(row.resource),
            id: String(row.id),
            kind: row.kind,
            serverVersion: Number(row.serverVersion),
            changedAt: Number(row.changedAt)
        }
    }

    async pullChangesByResource(args: {
        resource: string
        cursor: number
        limit: number
    }): Promise<AtomaChange[]> {
        const resource = String(args.resource ?? '').trim()
        if (!resource) return []
        const cursor = Math.max(0, Math.floor(args.cursor))
        const limit = Math.max(1, Math.floor(args.limit))

        const model = this.changes(this.client)
        if (!model?.findMany) return []

        const rows = await model.findMany({
            where: {
                resource,
                cursor: { gt: cursor }
            },
            orderBy: { cursor: 'asc' },
            take: limit
        })

        return rows.map((r: any) => ({
            cursor: Number(r.cursor),
            resource: String(r.resource),
            id: String(r.id),
            kind: r.kind,
            serverVersion: Number(r.serverVersion),
            changedAt: Number(r.changedAt)
        }))
    }

    async waitForResourceChanges(args: {
        resources?: string[]
        afterCursorByResource?: Record<string, number>
        timeoutMs: number
    }): Promise<Array<{ resource: string; cursor: number }>> {
        const allowList = (args.resources ?? [])
            .map(value => String(value ?? '').trim())
            .filter(Boolean)
        const allow = allowList.length ? new Set(allowList) : null
        const byResource = args.afterCursorByResource ?? {}
        const deadline = Date.now() + Math.max(0, args.timeoutMs)

        while (Date.now() < deadline) {
            const model = this.changes(this.client)
            if (!model?.findMany) return []

            const rows = await model.findMany({
                where: allowList.length
                    ? { resource: { in: allowList } }
                    : undefined,
                orderBy: { cursor: 'desc' },
                take: allowList.length
                    ? Math.max(allowList.length * 4, 50)
                    : 200
            })

            const seen = new Set<string>()
            const changed: Array<{ resource: string; cursor: number }> = []
            for (const row of rows) {
                const resource = String((row as any)?.resource ?? '').trim()
                if (!resource || seen.has(resource)) continue
                seen.add(resource)
                if (allow && !allow.has(resource)) continue

                const cursor = Number((row as any)?.cursor)
                if (!Number.isFinite(cursor) || cursor <= 0) continue

                const knownCursor = Math.max(0, Math.floor(Number(byResource[resource] ?? 0)))
                if (cursor <= knownCursor) continue

                changed.push({ resource, cursor: Math.floor(cursor) })
            }

            if (changed.length) return changed
            await new Promise(r => setTimeout(r, 250))
        }

        return []
    }
}

export function createPrismaServerAdapter(args: { client: PrismaClientLike }) {
    const orm = new AtomaPrismaAdapter(args.client)
    const sync = new AtomaPrismaSyncAdapter(args.client)
    return { orm, sync }
}
