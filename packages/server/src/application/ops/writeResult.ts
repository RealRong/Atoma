import { withErrorTrace } from '@atoma-js/types/protocol-tools'
import { normalizeId } from '../../shared/utils/id'
import { toStandard } from '../../shared/errors/standardError'
import { isObject } from './normalize'
export { serializeError as serializeErrorForLog } from '../../shared/logging/serializeError'
export { extractConflictMeta } from '../../domain/write/conflict'

export type TraceMeta = { traceId?: string; requestId?: string; opId: string }

function hasOwn(obj: any, key: string): boolean {
    return Boolean(obj) && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key)
}

export function validateCreateIdMatchesValue(raw: any): { ok: true } | { ok: false; reason: string } {
    const id = raw?.id
    const value = raw?.value
    if (id === undefined || id === null) return { ok: true }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: true }
    if (!hasOwn(value, 'id')) return { ok: true }

    const valueId = (value as any).id
    if (valueId === undefined || valueId === null) return { ok: true }

    const a = normalizeId(id)
    const b = normalizeId(valueId)
    if (!a || !b) return { ok: true }
    return a === b ? { ok: true } : { ok: false, reason: 'Create id does not match value.id' }
}

export function extractWriteItemMeta(raw: any): { idempotencyKey?: string } {
    const meta = isObject(raw?.meta) ? raw.meta : undefined
    const idempotencyKey = meta && typeof meta.idempotencyKey === 'string' ? meta.idempotencyKey : undefined
    return { idempotencyKey }
}

export function toOkItemResult(res: any) {
    return {
        ok: true,
        id: res.replay.id,
        version: res.replay.serverVersion,
        ...(res.data !== undefined ? { data: res.data } : {})
    }
}

export function toFailItemResult(res: any, trace: TraceMeta) {
    const currentValue = res.replay.currentValue
    const currentVersion = res.replay.currentVersion
    return {
        ok: false,
        error: withErrorTrace(res.error, trace),
        ...(currentValue !== undefined || currentVersion !== undefined
            ? { current: { ...(currentValue !== undefined ? { value: currentValue } : {}), ...(currentVersion !== undefined ? { version: currentVersion } : {}) } }
            : {})
    }
}

export function toUnhandledItemError(error: unknown, trace: TraceMeta) {
    return {
        ok: false,
        error: withErrorTrace(toStandard(error, 'WRITE_FAILED'), trace)
    }
}
