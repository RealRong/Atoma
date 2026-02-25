import type { AtomaChange, ISyncAdapter, IdempotencyResult } from '../ports'
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

    async getIdempotency(key: string, tx?: unknown): Promise<IdempotencyResult> {
        const client = this.clientFor(tx)
        const model = this.idempotency(client)
        if (!model?.findUnique) return { hit: false }

        const row = await model.findUnique({ where: { idempotencyKey: key } })
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
        const client = this.clientFor(tx)
        const model = this.idempotency(client)
        if (!model?.createMany && !model?.create) return

        const now = Date.now()
        const expiresAt = now + Math.max(0, Math.floor(ttlMs ?? 0))

        const data = {
            idempotencyKey: key,
            status: value.status,
            bodyJson: JSON.stringify(value.body ?? null),
            createdAt: now,
            expiresAt
        }

        const isUniqueViolation = (err: any) => {
            return Boolean(err && typeof err === 'object' && (err as any).code === 'P2002')
        }

        if (typeof model.create === 'function') {
            try {
                await model.create({ data })
                return
            } catch (err) {
                if (isUniqueViolation(err)) return
                throw err
            }
        }

        try {
            await model.createMany({ data: [data] })
        } catch (err) {
            if (isUniqueViolation(err)) return
            throw err
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
