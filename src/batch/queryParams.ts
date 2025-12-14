import type { FindManyOptions } from '../core/types'
import type { OrderByRule, Page, QueryParams } from '../server/types'

/**
 * Batch query params normalizer (client-side).
 *
 * Why this exists:
 * - Public querying APIs in Atoma use `FindManyOptions<T>` (developer-friendly shape).
 * - The Atoma server Batch protocol expects `QueryParams` where pagination MUST be expressed via `params.page`.
 *
 * What it does:
 * - Picks and normalizes only the server-supported query fields:
 *   - `where`   -> `params.where`   (plain object only)
 *   - `orderBy` -> `params.orderBy` (always an array of `{ field, direction }`)
 *   - `fields`  -> `params.select`  (sparse fieldset: `{ [field]: true }`)
 *   - pagination aliases -> `params.page`
 *     - offset pagination: `limit/offset/includeTotal` -> `{ mode:'offset', ... }`
 *     - cursor pagination: `after/before` or legacy `cursor` -> `{ mode:'cursor', ... }`
 *
 * What it does NOT do:
 * - It does not accept/forward raw server `QueryParams` as input.
 *   Callers should always pass `FindManyOptions<T>`; this function owns the translation boundary.
 * - It does not forward unknown/extra fields (e.g. `include`, `cache`, `traceId`, etc).
 *
 * Where it's used:
 * - `src/batch/queryLane.ts` calls this right before sending `POST /batch` to the Atoma server.
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

function normalizeSelect(fields: unknown): Record<string, boolean> | undefined {
    const out: Record<string, boolean> = {}

    if (Array.isArray(fields) && fields.length) {
        fields.forEach(f => {
            if (typeof f === 'string' && f) out[f] = true
        })
    }

    return Object.keys(out).length ? out : undefined
}

/**
 * Converts `FindManyOptions<T>` into server `QueryParams` for the Batch protocol.
 *
 * Invariants:
 * - Always returns a `QueryParams` object with `page` populated (Batch requires `params.page`).
 * - Never includes legacy pagination aliases (`limit/offset/includeTotal/after/before/cursor`) on the output root.
 * - Never forwards non-protocol fields from `FindManyOptions` (this is a strict "pick" normalizer).
 */
export function normalizeAtomaServerQueryParams<T>(input: FindManyOptions<T> | undefined): QueryParams {
    const i = (input && typeof input === 'object') ? input : undefined

    const out: QueryParams = {}

    const whereInput = i?.where as unknown
    if (isPlainObject(whereInput)) {
        out.where = { ...whereInput }
    }

    const orderBy = normalizeOrderBy(i?.orderBy as unknown)
    if (orderBy) out.orderBy = orderBy

    const select = normalizeSelect(i?.fields as unknown)
    if (select) out.select = select

    const limit = typeof i?.limit === 'number' ? i.limit : 50
    const offset = typeof i?.offset === 'number' ? i.offset : undefined
    const includeTotal = typeof i?.includeTotal === 'boolean' ? i.includeTotal : undefined

    const before = typeof i?.before === 'string' ? i.before : undefined
    const after = typeof i?.after === 'string' ? i.after : undefined
    const cursor = typeof i?.cursor === 'string' ? i.cursor : undefined

    if (before || after || cursor) {
        const page: Extract<Page, { mode: 'cursor' }> = { mode: 'cursor', limit }
        if (before) page.before = before
        const afterToken = after ?? cursor
        if (afterToken) page.after = afterToken
        out.page = page
        return out
    }

    const page: Extract<Page, { mode: 'offset' }> = { mode: 'offset', limit }
    if (offset !== undefined) page.offset = offset
    if (includeTotal !== undefined) page.includeTotal = includeTotal
    out.page = page

    return out
}
