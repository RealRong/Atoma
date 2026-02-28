import type { AtomaChange, ISyncAdapter, IdempotencyClaimResult, IdempotencyResult } from '../ports'
import { AtomaPrismaAdapter } from './PrismaAdapter'
import { appendChangeToModel, pullChangesByResourceFromModel, waitForResourceChangesFromModel } from './prismaSyncChangeFeed'
import { claimIdempotencyOnModel, getIdempotencyFromModel, putIdempotencyOnModel } from './prismaSyncIdempotency'

type PrismaClientLike = Record<string, any> & {
    $transaction?: any
}

type Options = {
    /**
     * Prisma 版本的“零反射”做法：要求用户在 schema.prisma 中显式定义这两个 model：
     * - atoma_changes
     * - atoma_idempotency
     */
    models?: {
        changes?: string
        idempotency?: string
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
        const value = tx as any
        return value && typeof value === 'object'
            ? (value as PrismaClientLike)
            : this.client
    }

    async getIdempotency(key: string, tx?: unknown): Promise<IdempotencyResult> {
        const client = this.clientFor(tx)
        return getIdempotencyFromModel({
            model: this.idempotency(client),
            key,
            now: Date.now()
        })
    }

    async claimIdempotency(
        key: string,
        value: { status: number; body: unknown },
        ttlMs?: number,
        tx?: unknown
    ): Promise<IdempotencyClaimResult> {
        const client = this.clientFor(tx)
        return claimIdempotencyOnModel({
            model: this.idempotency(client),
            key,
            value,
            ttlMs,
            now: Date.now()
        })
    }

    async putIdempotency(
        key: string,
        value: { status: number; body: unknown },
        ttlMs?: number,
        tx?: unknown
    ): Promise<void> {
        const client = this.clientFor(tx)
        await putIdempotencyOnModel({
            model: this.idempotency(client),
            key,
            value,
            ttlMs,
            now: Date.now()
        })
    }

    async appendChange(change: Omit<AtomaChange, 'cursor'>, tx?: unknown): Promise<AtomaChange> {
        const client = this.clientFor(tx)
        return appendChangeToModel({
            model: this.changes(client),
            change
        })
    }

    async pullChangesByResource(args: {
        resource: string
        cursor: number
        limit: number
    }): Promise<AtomaChange[]> {
        return pullChangesByResourceFromModel({
            model: this.changes(this.client),
            resource: args.resource,
            cursor: args.cursor,
            limit: args.limit
        })
    }

    async waitForResourceChanges(args: {
        resources?: string[]
        afterCursorByResource?: Record<string, number>
        timeoutMs: number
    }): Promise<Array<{ resource: string; cursor: number }>> {
        return waitForResourceChangesFromModel({
            model: this.changes(this.client),
            resources: args.resources,
            afterCursorByResource: args.afterCursorByResource,
            timeoutMs: args.timeoutMs
        })
    }
}

export function createPrismaServerAdapter(args: { client: PrismaClientLike }) {
    const orm = new AtomaPrismaAdapter(args.client)
    const sync = new AtomaPrismaSyncAdapter(args.client)
    return { orm, sync }
}
