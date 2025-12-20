import { StoreKey, PatchMetadata } from '../../core/types'
import { Patch } from 'immer'
import { ETagManager } from './etagManager'
import { makeUrl, sendJson, sendDelete, sendDeleteJson, sendPutJson, RequestSender, resolveEndpoint } from './request'
import type { VersionConfig } from '../HTTPAdapter'
import type { ObservabilityContext } from '../../observability/types'
import { utf8ByteLength } from '../../observability/utf8'

export interface ClientConfig {
    baseURL: string
    endpoints: {
        create: string | (() => string)
        update: string | ((id: StoreKey) => string)
        delete: string | ((id: StoreKey) => string)
        patch?: string | ((id: StoreKey) => string)
        bulkCreate?: string | (() => string)
        bulkUpdate?: string | (() => string)
        bulkDelete?: string | (() => string)
    }
    version?: VersionConfig
}

export interface ConflictHandler<T> {
    handle: (
        response: Response,
        key: StoreKey,
        localValue: T | Patch[],
        conflictBody?: any,
        metadata?: PatchMetadata
    ) => Promise<void>
}

export class HTTPClient<T> {
    constructor(
        private config: ClientConfig,
        private sender: RequestSender,
        private etagManager: ETagManager,
        private getHeaders: () => Promise<Record<string, string>>,
        private conflictHandler: ConflictHandler<T>
    ) { }

    async put(
        key: StoreKey,
        value: T,
        extraHeaders?: Record<string, string>,
        ctx?: ObservabilityContext
    ): Promise<void> {
        const endpoint = resolveEndpoint(this.config.endpoints.update, key)
        const url = makeUrl(this.config.baseURL, endpoint)
        const headers = { ...(await this.getHeaders()), ...(extraHeaders || {}) }

        this.etagManager.attachVersion(headers, this.config.version, value, key)

        const shouldEmit = Boolean(ctx?.active)
        const payloadBytes = shouldEmit ? utf8ByteLength(JSON.stringify(value)) : undefined
        const startedAt = shouldEmit ? Date.now() : 0
        ctx?.emit('adapter:request', {
            method: 'PUT',
            endpoint,
            attempt: 1,
            payloadBytes
        })

        const response = await sendPutJson(this.sender, url, value, headers)

        ctx?.emit('adapter:response', {
            ok: response.ok,
            status: response.status,
            durationMs: shouldEmit ? (Date.now() - startedAt) : undefined
        })

        if (response.status === 409) {
            await this.conflictHandler.handle(response, key, value)
            return
        }

        const newEtag = this.etagManager.extractFromResponse(response)
        if (newEtag) {
            this.etagManager.set(key, newEtag)
        }
    }

    async create(
        _key: StoreKey,
        value: T,
        extraHeaders?: Record<string, string>,
        ctx?: ObservabilityContext
    ): Promise<T | undefined> {
        const endpoint = resolveEndpoint(this.config.endpoints.create)
        const url = makeUrl(this.config.baseURL, endpoint)
        const headers = { ...(await this.getHeaders()), ...(extraHeaders || {}) }

        this.etagManager.attachVersion(headers, this.config.version, value, undefined as any)

        const shouldEmit = Boolean(ctx?.active)
        const payloadBytes = shouldEmit ? utf8ByteLength(JSON.stringify(value)) : undefined
        const startedAt = shouldEmit ? Date.now() : 0
        ctx?.emit('adapter:request', {
            method: 'POST',
            endpoint,
            attempt: 1,
            payloadBytes
        })

        const response = await sendJson(this.sender, url, value, headers)

        ctx?.emit('adapter:response', {
            ok: response.ok,
            status: response.status,
            durationMs: shouldEmit ? (Date.now() - startedAt) : undefined
        })

        const etag = this.etagManager.extractFromResponse(response)
        if (etag) {
            const parsed = await this.safeParse(response)
            const parsedId = (parsed as any)?.id as StoreKey | undefined
            if (parsedId !== undefined) this.etagManager.set(parsedId, etag)
        }

        return this.safeParse(response)
    }

    private async safeParse(response: Response): Promise<T | undefined> {
        try {
            const json = await response.clone().json()
            if (json && typeof json === 'object') {
                if ('data' in json) return (json as any).data as T
                return json as T
            }
        } catch {
            // ignore
        }
        return undefined
    }

    async delete(
        key: StoreKey,
        metaOrHeaders?: { baseVersion: number; idempotencyKey?: string } | Record<string, string>,
        extraHeadersOrCtx?: Record<string, string> | ObservabilityContext,
        ctxMaybe?: ObservabilityContext
    ): Promise<void> {
        const meta = (metaOrHeaders && typeof metaOrHeaders === 'object' && !Array.isArray(metaOrHeaders) && typeof (metaOrHeaders as any).baseVersion === 'number')
            ? (metaOrHeaders as any)
            : undefined
        const extraHeaders = meta ? (extraHeadersOrCtx as any) : (metaOrHeaders as any)
        const ctx = meta ? ctxMaybe : (extraHeadersOrCtx as any)

        const endpoint = resolveEndpoint(this.config.endpoints.delete, key)
        const url = makeUrl(this.config.baseURL, endpoint)
        const headers = { ...(await this.getHeaders()), ...(extraHeaders || {}) }

        this.etagManager.attachVersion(headers, this.config.version, undefined, key)

        const shouldEmit = Boolean(ctx?.active)
        const startedAt = shouldEmit ? Date.now() : 0
        ctx?.emit('adapter:request', {
            method: 'DELETE',
            endpoint,
            attempt: 1,
            payloadBytes: 0
        })

        const response = meta
            ? await sendDeleteJson(this.sender, url, { baseVersion: meta.baseVersion, idempotencyKey: meta.idempotencyKey }, headers)
            : await sendDelete(this.sender, url, headers)

        ctx?.emit('adapter:response', {
            ok: response.ok,
            status: response.status,
            durationMs: shouldEmit ? (Date.now() - startedAt) : undefined
        })

        if (response.status === 409 || !response.ok) {
            const body = await (async () => {
                try {
                    return await response.clone().json()
                } catch {
                    return undefined
                }
            })()
            const err = new Error(response.status === 409 ? 'Conflict' : `Request failed: ${response.status}`)
            ;(err as any).status = response.status
            ;(err as any).body = body
            throw err
        }

        this.etagManager.delete(key)
    }

    async patch(
        id: StoreKey,
        patches: Patch[],
        metadata: PatchMetadata,
        extraHeaders?: Record<string, string>,
        ctx?: ObservabilityContext
    ): Promise<void> {
        const patchEndpoint = this.config.endpoints.patch || this.config.endpoints.update
        const endpoint = resolveEndpoint(patchEndpoint, id)
        const url = makeUrl(this.config.baseURL, endpoint)
        const headers = { ...(await this.getHeaders()), ...(extraHeaders || {}) }

        this.etagManager.attachVersion(headers, this.config.version, metadata)

        const body = {
            patches,
            baseVersion: metadata.baseVersion,
            timestamp: metadata.timestamp
        }
        const shouldEmit = Boolean(ctx?.active)
        const payloadBytes = shouldEmit ? utf8ByteLength(JSON.stringify(body)) : undefined
        const startedAt = shouldEmit ? Date.now() : 0
        ctx?.emit('adapter:request', {
            method: 'POST',
            endpoint,
            attempt: 1,
            payloadBytes
        })

        const response = await sendJson(
            this.sender,
            url,
            body,
            headers
        )

        ctx?.emit('adapter:response', {
            ok: response.ok,
            status: response.status,
            durationMs: shouldEmit ? (Date.now() - startedAt) : undefined
        })

        if (response.status === 409) {
            const conflict = await response.json()
            await this.conflictHandler.handle(response, id, patches, conflict, metadata)
        } else {
            const etag = this.etagManager.extractFromResponse(response)
            if (etag) {
                this.etagManager.set(id, etag)
            }
        }
    }

    async bulkUpdate(
        items: T[],
        extraHeaders?: Record<string, string>,
        ctx?: ObservabilityContext
    ): Promise<void> {
        if (!this.config.endpoints.bulkUpdate) return
        const endpoint = resolveEndpoint(this.config.endpoints.bulkUpdate)
        const url = makeUrl(this.config.baseURL, endpoint)
        const headers = { ...(await this.getHeaders()), ...(extraHeaders || {}) }
        const body = { items }
        const shouldEmit = Boolean(ctx?.active)
        const payloadBytes = shouldEmit ? utf8ByteLength(JSON.stringify(body)) : undefined
        const startedAt = shouldEmit ? Date.now() : 0
        ctx?.emit('adapter:request', {
            method: 'POST',
            endpoint,
            attempt: 1,
            payloadBytes
        })
        const response = await sendJson(this.sender, url, body, headers)
        ctx?.emit('adapter:response', {
            ok: response.ok,
            status: response.status,
            durationMs: shouldEmit ? (Date.now() - startedAt) : undefined
        })
        if (!response.ok) {
            throw new Error(`Bulk update failed: ${response.status}`)
        }
    }

    async bulkCreate(
        items: T[],
        extraHeaders?: Record<string, string>,
        ctx?: ObservabilityContext
    ): Promise<T[] | undefined> {
        if (!this.config.endpoints.bulkCreate) return
        const endpoint = resolveEndpoint(this.config.endpoints.bulkCreate)
        const url = makeUrl(this.config.baseURL, endpoint)
        const headers = { ...(await this.getHeaders()), ...(extraHeaders || {}) }
        const body = { items }
        const shouldEmit = Boolean(ctx?.active)
        const payloadBytes = shouldEmit ? utf8ByteLength(JSON.stringify(body)) : undefined
        const startedAt = shouldEmit ? Date.now() : 0
        ctx?.emit('adapter:request', {
            method: 'POST',
            endpoint,
            attempt: 1,
            payloadBytes
        })
        const response = await sendJson(this.sender, url, body, headers)
        ctx?.emit('adapter:response', {
            ok: response.ok,
            status: response.status,
            durationMs: shouldEmit ? (Date.now() - startedAt) : undefined
        })
        if (!response.ok) {
            throw new Error(`Bulk create failed: ${response.status}`)
        }
        return this.safeParseArray(response)
    }

    private async safeParseArray(response: Response): Promise<T[] | undefined> {
        try {
            const json = await response.clone().json()
            if (Array.isArray(json)) return json as T[]
            if (json && Array.isArray((json as any).data)) return (json as any).data as T[]
        } catch {
            // ignore
        }
        return undefined
    }

    async bulkDelete(
        keys: StoreKey[],
        extraHeaders?: Record<string, string>,
        ctx?: ObservabilityContext
    ): Promise<void> {
        if (!this.config.endpoints.bulkDelete) return
        const endpoint = resolveEndpoint(this.config.endpoints.bulkDelete)
        const url = makeUrl(this.config.baseURL, endpoint)
        const headers = { ...(await this.getHeaders()), ...(extraHeaders || {}) }
        const body = { ids: keys }
        const shouldEmit = Boolean(ctx?.active)
        const payloadBytes = shouldEmit ? utf8ByteLength(JSON.stringify(body)) : undefined
        const startedAt = shouldEmit ? Date.now() : 0
        ctx?.emit('adapter:request', {
            method: 'POST',
            endpoint,
            attempt: 1,
            payloadBytes
        })
        const response = await sendJson(this.sender, url, body, headers)
        ctx?.emit('adapter:response', {
            ok: response.ok,
            status: response.status,
            durationMs: shouldEmit ? (Date.now() - startedAt) : undefined
        })
        if (!response.ok) {
            throw new Error(`Bulk delete failed: ${response.status}`)
        }
        keys.forEach(k => this.etagManager.delete(k))
    }
}
