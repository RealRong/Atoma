import type { IdempotencyClaimResult, IdempotencyResult } from '../ports'

function parseStoredBody(bodyJson: unknown): unknown {
    if (typeof bodyJson !== 'string' || !bodyJson) return undefined
    try {
        return JSON.parse(bodyJson)
    } catch {
        return undefined
    }
}

function normalizeExpiry(expiresAt: unknown): number | undefined {
    const value = typeof expiresAt === 'number' ? expiresAt : Number(expiresAt)
    if (!Number.isFinite(value)) return undefined
    return Math.floor(value)
}

function normalizeStatus(status: unknown): number | undefined {
    const value = typeof status === 'number' ? status : Number(status)
    if (!Number.isFinite(value)) return undefined
    return Math.floor(value)
}

function isExpired(expiresAt: unknown, now: number): boolean {
    const expiry = normalizeExpiry(expiresAt)
    return typeof expiry === 'number' && expiry > 0 && now > expiry
}

function readClaimExisting(row: any): IdempotencyClaimResult {
    const status = normalizeStatus(row?.status)
    const body = parseStoredBody(row?.bodyJson)
    return {
        acquired: false,
        ...(typeof status === 'number' ? { status } : {}),
        ...(body !== undefined ? { body } : {})
    }
}

function isUniqueViolation(error: any) {
    return Boolean(error && typeof error === 'object' && (error as any).code === 'P2002')
}

export async function getIdempotencyFromModel(args: {
    model: any
    key: string
    now: number
}): Promise<IdempotencyResult> {
    if (!args.model?.findUnique) return { hit: false }

    const row = await args.model.findUnique({ where: { idempotencyKey: args.key } })
    if (!row) return { hit: false }
    if (isExpired(row.expiresAt, args.now)) return { hit: false }

    const status = normalizeStatus(row.status)
    if (typeof status !== 'number') return { hit: false }
    const body = parseStoredBody(row.bodyJson)
    return { hit: true, status, body }
}

export async function claimIdempotencyOnModel(args: {
    model: any
    key: string
    value: { status: number; body: unknown }
    ttlMs?: number
    now: number
}): Promise<IdempotencyClaimResult> {
    if (!args.model?.findUnique || !args.model?.create) {
        return { acquired: true }
    }

    const expiresAt = args.now + Math.max(0, Math.floor(args.ttlMs ?? 0))
    const data = {
        idempotencyKey: args.key,
        status: args.value.status,
        bodyJson: JSON.stringify(args.value.body ?? null),
        createdAt: args.now,
        expiresAt
    }

    const existing = await args.model.findUnique({ where: { idempotencyKey: args.key } })
    if (existing) {
        if (!isExpired(existing.expiresAt, args.now)) {
            return readClaimExisting(existing)
        }
        if (typeof args.model.deleteMany === 'function') {
            await args.model.deleteMany({
                where: {
                    idempotencyKey: args.key,
                    expiresAt: { lte: args.now }
                }
            })
        }
    }

    try {
        await args.model.create({ data })
        return { acquired: true }
    } catch (error) {
        if (!isUniqueViolation(error)) throw error
    }

    const winner = await args.model.findUnique({ where: { idempotencyKey: args.key } })
    if (!winner) return { acquired: false }
    return readClaimExisting(winner)
}

export async function putIdempotencyOnModel(args: {
    model: any
    key: string
    value: { status: number; body: unknown }
    ttlMs?: number
    now: number
}) {
    const upsert = args.model?.upsert
    if (typeof upsert !== 'function') {
        throw new Error('Prisma idempotency model must implement upsert(idempotencyKey).')
    }

    const expiresAt = args.now + Math.max(0, Math.floor(args.ttlMs ?? 0))
    const data = {
        idempotencyKey: args.key,
        status: args.value.status,
        bodyJson: JSON.stringify(args.value.body ?? null),
        createdAt: args.now,
        expiresAt
    }

    await upsert({
        where: { idempotencyKey: args.key },
        create: data,
        update: data
    })
}
