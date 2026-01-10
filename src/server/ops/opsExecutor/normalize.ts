import { throwError } from '../../error'
import type {
    ChangesPullOp,
    Meta,
    Operation,
    QueryOp,
    WriteAction,
    WriteItem,
    WriteOp,
    WriteOptions
} from '#protocol'
import type { QueryParams } from '../../adapters/ports'

type JsonObject = Record<string, unknown>

export type OpsRequest = {
    meta: Meta
    ops: unknown[]
}

export function isObject(value: unknown): value is JsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readString(obj: JsonObject, key: string): string | undefined {
    const v = obj[key]
    return typeof v === 'string' ? v : undefined
}

function readNumber(obj: JsonObject, key: string): number | undefined {
    const v = obj[key]
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function normalizeMeta(value: unknown): Meta {
    if (!isObject(value)) {
        throwError('INVALID_REQUEST', 'Invalid meta', { kind: 'validation' })
    }
    const v = readNumber(value, 'v')
    if (v === undefined) {
        throwError('INVALID_REQUEST', 'Missing meta.v', { kind: 'validation' })
    }
    const deviceId = readString(value, 'deviceId')
    const traceId = readString(value, 'traceId')
    const requestId = readString(value, 'requestId')
    const clientTimeMs = readNumber(value, 'clientTimeMs')
    return {
        v,
        ...(deviceId ? { deviceId } : {}),
        ...(traceId ? { traceId } : {}),
        ...(requestId ? { requestId } : {}),
        ...(clientTimeMs !== undefined ? { clientTimeMs } : {})
    }
}

export function normalizeOpsRequest(value: unknown): OpsRequest {
    if (!isObject(value)) {
        throwError('INVALID_REQUEST', 'Invalid body', { kind: 'validation' })
    }
    const meta = normalizeMeta(value.meta)
    const ops = Array.isArray(value.ops) ? value.ops : undefined
    if (!ops) {
        throwError('INVALID_REQUEST', 'Missing ops', { kind: 'validation' })
    }
    return { meta, ops }
}

function normalizeOpMeta(value: unknown): Meta | undefined {
    if (!isObject(value)) return undefined
    const traceId = readString(value, 'traceId')
    const requestId = readString(value, 'requestId')
    if (!traceId && !requestId) return undefined
    const v = readNumber(value, 'v')
    return {
        v: v === undefined ? 1 : v,
        ...(traceId ? { traceId } : {}),
        ...(requestId ? { requestId } : {})
    }
}

export function normalizeOperation(value: unknown): Operation {
    if (!isObject(value)) {
        throwError('INVALID_REQUEST', 'Invalid op', { kind: 'validation' })
    }
    const opId = readString(value, 'opId')
    if (!opId) {
        throwError('INVALID_REQUEST', 'Missing opId', { kind: 'validation' })
    }
    const kind = readString(value, 'kind')
    if (!kind) {
        throwError('INVALID_REQUEST', 'Missing kind', { kind: 'validation', opId })
    }

    const meta = normalizeOpMeta((value as any).meta)

    if (kind === 'query') {
        if (!isObject(value.query)) {
            throwError('INVALID_REQUEST', 'Missing query', { kind: 'validation', opId })
        }
        const resource = readString(value.query, 'resource')
        if (!resource) {
            throwError('INVALID_REQUEST', 'Missing query.resource', { kind: 'validation', opId })
        }
        const params = (value.query as any).params
        if (!isObject(params)) {
            throwError('INVALID_REQUEST', 'Missing query.params', { kind: 'validation', opId })
        }
        return {
            opId,
            kind: 'query',
            ...(meta ? { meta } : {}),
            query: { resource, params: params as QueryParams }
        } satisfies QueryOp
    }

    if (kind === 'write') {
        if (!isObject(value.write)) {
            throwError('INVALID_REQUEST', 'Missing write', { kind: 'validation', opId })
        }
        const resource = readString(value.write, 'resource')
        if (!resource) {
            throwError('INVALID_REQUEST', 'Missing write.resource', { kind: 'validation', opId })
        }
        const action = readString(value.write, 'action') as WriteAction | undefined
        if (action !== 'create' && action !== 'update' && action !== 'delete' && action !== 'upsert') {
            throwError('INVALID_REQUEST', 'Invalid write.action', { kind: 'validation', opId })
        }
        const items = Array.isArray(value.write.items) ? value.write.items : undefined
        if (!items) {
            throwError('INVALID_REQUEST', 'Missing write.items', { kind: 'validation', opId })
        }
        const optionsRaw = value.write.options
        const options = optionsRaw !== undefined ? (optionsRaw as unknown as WriteOptions) : undefined
        return {
            opId,
            kind: 'write',
            ...(meta ? { meta } : {}),
            write: {
                resource,
                action,
                items: items as unknown as WriteItem[],
                ...(options ? { options } : {})
            }
        } satisfies WriteOp
    }

    if (kind === 'changes.pull') {
        if (!isObject(value.pull)) {
            throwError('INVALID_REQUEST', 'Missing pull', { kind: 'validation', opId })
        }
        const cursor = readString(value.pull, 'cursor')
        const limit = readNumber(value.pull, 'limit')
        if (cursor === undefined || limit === undefined) {
            throwError('INVALID_REQUEST', 'Missing pull.cursor or pull.limit', { kind: 'validation', opId })
        }
        const resources = Array.isArray((value.pull as any).resources)
            ? (value.pull as any).resources.filter((r: any) => typeof r === 'string')
            : undefined
        return {
            opId,
            kind: 'changes.pull',
            ...(meta ? { meta } : {}),
            pull: { cursor, limit, ...(resources ? { resources } : {}) }
        } satisfies ChangesPullOp
    }

    throwError('INVALID_REQUEST', `Unsupported op kind: ${kind}`, { kind: 'validation', opId })
}

export function ensureV1(meta: Meta) {
    if (meta.v === 1) return
    throwError('PROTOCOL_UNSUPPORTED_VERSION', 'Unsupported protocol version', {
        kind: 'validation',
        supported: [1],
        received: meta.v
    })
}

export function clampQueryLimit(params: QueryParams, maxLimit: number) {
    if (typeof (params as any)?.limit === 'number' && (params as any).limit > maxLimit) {
        ;(params as any).limit = maxLimit
    }
}

export function parseCursorV1(cursor: string): number {
    if (!cursor.match(/^[0-9]+$/)) {
        throwError('INVALID_REQUEST', 'Invalid cursor', { kind: 'validation' })
    }
    const n = Number(cursor)
    if (!Number.isFinite(n) || n < 0) {
        throwError('INVALID_REQUEST', 'Invalid cursor', { kind: 'validation' })
    }
    return n
}
