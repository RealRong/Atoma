import type { Meta } from '../../../core/meta'
import { assertFiniteNumber, invalid, isObject, readNumber, readString } from './common'

export function assertMetaV1(value: unknown): Meta {
    if (!isObject(value)) throw invalid('INVALID_REQUEST', 'Invalid meta', { kind: 'validation', part: 'meta' })
    const v = readNumber(value, 'v')
    if (v !== 1) {
        if (v === undefined) throw invalid('INVALID_REQUEST', 'Missing meta.v', { kind: 'validation', part: 'meta', field: 'v' })
        throw invalid('PROTOCOL_UNSUPPORTED_VERSION', 'Unsupported protocol version', { kind: 'validation', part: 'meta', supported: [1], received: v })
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

export function assertOpMeta(value: unknown): Meta | undefined {
    if (!isObject(value)) return undefined
    const traceId = readString(value, 'traceId')
    const requestId = readString(value, 'requestId')
    if (!traceId && !requestId) return undefined
    const v = readNumber(value, 'v')
    if (v !== undefined) {
        assertFiniteNumber(v, { code: 'INVALID_REQUEST', message: 'Invalid meta.v', details: { kind: 'validation', part: 'op', field: 'meta.v' } })
    }
    return {
        v: v === undefined ? 1 : v,
        ...(traceId ? { traceId } : {}),
        ...(requestId ? { requestId } : {})
    }
}

