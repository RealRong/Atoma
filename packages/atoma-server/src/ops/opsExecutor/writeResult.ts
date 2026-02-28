import { toStandardError } from '../../error'
import { withErrorTrace } from 'atoma-types/protocol-tools'
import { isObject } from './normalize'

export type TraceMeta = { traceId?: string; requestId?: string; opId: string }

export function serializeErrorForLog(error: unknown) {
    if (error instanceof Error) {
        const anyErr = error as any
        return {
            name: error.name,
            message: error.message,
            stack: error.stack,
            ...(anyErr?.cause !== undefined ? { cause: anyErr.cause } : {})
        }
    }
    return { value: error }
}

function normalizeId(value: unknown): string {
    if (typeof value === 'string') return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    if (value === null || value === undefined) return ''
    return String(value)
}

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
    if (a !== b) return { ok: false, reason: 'Create id does not match value.id' }
    return { ok: true }
}

export function extractConflictMeta(error: any) {
    const details = (error as any)?.details
    const currentValue = details && typeof details === 'object' ? (details as any).currentValue : undefined
    const currentVersion = details && typeof details === 'object' ? (details as any).currentVersion : undefined
    return {
        ...(currentValue !== undefined ? { currentValue } : {}),
        ...(typeof currentVersion === 'number' ? { currentVersion } : {})
    }
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

export function toUnhandledItemError(err: unknown, trace: TraceMeta) {
    return {
        ok: false,
        error: withErrorTrace(toStandardError(err, 'WRITE_FAILED'), trace)
    }
}
