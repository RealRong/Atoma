import type { Meta } from '../../core/meta'
import { assertFiniteNumber, invalid, isObject, makeValidationDetails, readNumber, readString, requireObject } from './common'

export function assertMeta(value: unknown): Meta {
    const detailsForMeta = makeValidationDetails('meta')
    const obj = requireObject(value, { code: 'INVALID_REQUEST', message: 'Invalid meta', details: detailsForMeta() })
    const v = readNumber(obj, 'v')
    if (v !== 1) {
        if (v === undefined) throw invalid('INVALID_REQUEST', 'Missing meta.v', detailsForMeta('v'))
        throw invalid('PROTOCOL_UNSUPPORTED_VERSION', 'Unsupported protocol version', detailsForMeta(undefined, { supported: [1], received: v }))
    }
    const deviceId = readString(obj, 'deviceId')
    const traceId = readString(obj, 'traceId')
    const requestId = readString(obj, 'requestId')
    const clientTimeMs = readNumber(obj, 'clientTimeMs')
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
        const detailsForOp = makeValidationDetails('op')
        assertFiniteNumber(v, { code: 'INVALID_REQUEST', message: 'Invalid meta.v', details: detailsForOp('meta.v') })
    }
    return {
        v: v === undefined ? 1 : v,
        ...(traceId ? { traceId } : {}),
        ...(requestId ? { requestId } : {})
    }
}
