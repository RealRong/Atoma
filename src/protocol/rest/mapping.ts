import type { BatchOp, BatchRequest } from '../batch/types'
import { queryParamsFromSearchParams, toNumberIfFinite } from './normalize'

type RestMappingParams = {
    method: string
    pathParts: string[]
    searchParams: URLSearchParams
    body: any
}

export function restMapping({ method, pathParts, searchParams, body }: RestMappingParams): BatchRequest | null {
    const resource = pathParts[0]
    const id = pathParts[1]
    if (!resource) return null

    const params = queryParamsFromSearchParams(searchParams)
    const numericId = toNumberIfFinite(id)
    const opId = 'rest:0'

    if (method === 'GET') {
        if (id !== undefined) {
            params.where = { ...(params.where || {}), id: numericId }
            params.page = { mode: 'offset', limit: 1, includeTotal: false }
        }
        const op: BatchOp = { opId, action: 'query', query: { resource, params } }
        return { ops: [op] }
    }

    if (method === 'POST' && id === undefined) {
        const op: BatchOp = {
            opId,
            action: 'bulkCreate',
            resource,
            payload: [{ data: body }]
        }
        return { ops: [op] }
    }

    if ((method === 'PUT' || method === 'PATCH' || method === 'POST') && id !== undefined) {
        const isPatch = body && typeof body === 'object' && Array.isArray((body as any).patches)
        if (isPatch) {
            const op: BatchOp = {
                opId,
                action: 'bulkPatch',
                resource,
                payload: [{
                    id: numericId,
                    patches: (body as any).patches,
                    baseVersion: (body as any).baseVersion,
                    timestamp: (body as any).timestamp,
                    ...(typeof (body as any).idempotencyKey === 'string' && (body as any).idempotencyKey
                        ? { meta: { idempotencyKey: (body as any).idempotencyKey } }
                        : {})
                }] as any
            }
            return { ops: [op] }
        }

        const full = (body && typeof body === 'object') ? { ...stripWriteMeta(body), id: numericId } : { id: numericId }
        const op: BatchOp = {
            opId,
            action: 'bulkPatch',
            resource,
            payload: [{
                id: numericId,
                patches: [{ op: 'replace', path: [numericId], value: full }],
                baseVersion: (body as any)?.baseVersion,
                timestamp: (body as any)?.timestamp,
                ...(typeof (body as any)?.idempotencyKey === 'string' && (body as any).idempotencyKey
                    ? { meta: { idempotencyKey: (body as any).idempotencyKey } }
                    : {})
            }] as any
        }
        return { ops: [op] }
    }

    if (method === 'DELETE' && id !== undefined) {
        const op: BatchOp = {
            opId,
            action: 'bulkDelete',
            resource,
            payload: [{
                id: numericId,
                baseVersion: (body as any)?.baseVersion,
                ...(typeof (body as any)?.idempotencyKey === 'string' && (body as any).idempotencyKey
                    ? { meta: { idempotencyKey: (body as any).idempotencyKey } }
                    : {})
            }] as any
        }
        return { ops: [op] }
    }

    return null
}

function stripWriteMeta(body: any) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return body
    const { baseVersion, timestamp, idempotencyKey, patches, ...rest } = body as any
    return rest
}
