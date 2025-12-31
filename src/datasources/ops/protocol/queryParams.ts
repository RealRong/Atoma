import type { FindManyOptions } from '#core'
import type { OrderByRule, QueryParams } from '#protocol'

/**
 * Ops query params normalizer (client-side).
 *
 * Why this exists:
 * - Public querying APIs in Atoma use `FindManyOptions<T>` (developer-friendly shape).
 * - The Atoma server ops protocol accepts `QueryParams` that mirrors `FindManyOptions` pagination fields.
 *
 * What it does:
 * - Picks and normalizes only the server-supported query fields:
 *   - `where`   -> `params.where`   (plain object only)
 *   - `orderBy` -> `params.orderBy` (always an array of `{ field, direction }`)
 *   - `fields`  -> `params.fields`
 *   - pagination fields -> `params.limit/offset/includeTotal/after/before`
 *
 * What it does NOT do:
 * - It does not accept/forward raw server `QueryParams` as input.
 *   Callers should always pass `FindManyOptions<T>`; this function owns the translation boundary.
 * - It does not forward unknown/extra fields (e.g. `include`, `cache`, `traceId`, etc).
 *
 * Where it's used:
 * - `OpsDataSource` builds QueryOp params with this helper before calling `/ops`.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeOrderBy(orderBy: unknown): OrderByRule[] | undefined {
    if (!orderBy) return undefined
    const arr = Array.isArray(orderBy) ? orderBy : [orderBy]
    const rules: OrderByRule[] = []
    for (const r of arr) {
        if (!isPlainObject(r)) continue
        const field = r.field
        const direction = r.direction
        if (typeof field !== 'string') continue
        if (direction !== 'asc' && direction !== 'desc') continue
        rules.push({ field, direction })
    }
    return rules.length ? rules : undefined
}

/**
 * Converts `FindManyOptions<T>` into server `QueryParams` for the Batch protocol.
 *
 * Invariants:
 * - Never forwards non-protocol fields from `FindManyOptions` (this is a strict "pick" normalizer).
 */
export function normalizeAtomaServerQueryParams<T>(input: FindManyOptions<T> | undefined): QueryParams {
    const i = (input && typeof input === 'object') ? input : undefined

    const out: QueryParams = {}

    const whereInput: unknown = i?.where
    if (isPlainObject(whereInput)) {
        out.where = { ...whereInput }
    }

    const orderBy = normalizeOrderBy(i?.orderBy)
    if (orderBy) out.orderBy = orderBy

    if (Array.isArray(i?.fields) && i!.fields!.length) {
        out.fields = i!.fields!.filter(f => typeof f === 'string' && f)
    }

    const limit = (typeof i?.limit === 'number' && Number.isFinite(i.limit)) ? i.limit : 50
    out.limit = limit
    if (typeof i?.offset === 'number' && Number.isFinite(i.offset)) out.offset = i.offset
    if (typeof i?.includeTotal === 'boolean') out.includeTotal = i.includeTotal

    const after = (typeof i?.after === 'string' && i.after) ? i.after : undefined
    const cursor = (typeof i?.cursor === 'string' && i.cursor) ? i.cursor : undefined
    const afterOrCursor = after ?? cursor
    if (afterOrCursor) out.after = afterOrCursor
    if (typeof i?.before === 'string' && i.before) out.before = i.before

    return out
}
