import { StoreKey, PatchMetadata } from '../../core/types'
import { Patch } from 'immer'
import { ETagManager } from './etagManager'
import { makeUrl, sendJson, sendDelete, sendPutJson, RequestSender, resolveEndpoint } from './request'
import type { VersionConfig } from '../HTTPAdapter'
import type { DebugEmitter } from '../../observability/debug'
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
        debug?: { emitter: DebugEmitter; requestId?: string }
    ): Promise<void> {
        const endpoint = resolveEndpoint(this.config.endpoints.update, key)
        const url = makeUrl(this.config.baseURL, endpoint)
        const headers = { ...(await this.getHeaders()), ...(extraHeaders || {}) }

        this.etagManager.attachVersion(headers, this.config.version, value, key)

        const payloadBytes = debug ? utf8ByteLength(JSON.stringify(value)) : undefined
        const startedAt = debug ? Date.now() : 0
        debug?.emitter.emit('adapter:request', {
            method: 'PUT',
            endpoint,
            attempt: 1,
            payloadBytes
        }, { requestId: debug.requestId })

        const response = await sendPutJson(this.sender, url, value, headers)

        debug?.emitter.emit('adapter:response', {
            ok: response.ok,
            status: response.status,
            durationMs: Date.now() - startedAt
        }, { requestId: debug.requestId })

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
        debug?: { emitter: DebugEmitter; requestId?: string }
    ): Promise<T | undefined> {
        const endpoint = resolveEndpoint(this.config.endpoints.create)
        const url = makeUrl(this.config.baseURL, endpoint)
        const headers = { ...(await this.getHeaders()), ...(extraHeaders || {}) }

        this.etagManager.attachVersion(headers, this.config.version, value, undefined as any)

        const payloadBytes = debug ? utf8ByteLength(JSON.stringify(value)) : undefined
        const startedAt = debug ? Date.now() : 0
        debug?.emitter.emit('adapter:request', {
            method: 'POST',
            endpoint,
            attempt: 1,
            payloadBytes
        }, { requestId: debug.requestId })

        const response = await sendJson(this.sender, url, value, headers)

        debug?.emitter.emit('adapter:response', {
            ok: response.ok,
            status: response.status,
            durationMs: Date.now() - startedAt
        }, { requestId: debug.requestId })

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
        extraHeaders?: Record<string, string>,
        debug?: { emitter: DebugEmitter; requestId?: string }
    ): Promise<void> {
        const endpoint = resolveEndpoint(this.config.endpoints.delete, key)
        const url = makeUrl(this.config.baseURL, endpoint)
        const headers = { ...(await this.getHeaders()), ...(extraHeaders || {}) }

        this.etagManager.attachVersion(headers, this.config.version, undefined, key)

        const startedAt = debug ? Date.now() : 0
        debug?.emitter.emit('adapter:request', {
            method: 'DELETE',
            endpoint,
            attempt: 1,
            payloadBytes: 0
        }, { requestId: debug.requestId })

        const response = await sendDelete(this.sender, url, headers)

        debug?.emitter.emit('adapter:response', {
            ok: response.ok,
            status: response.status,
            durationMs: Date.now() - startedAt
        }, { requestId: debug.requestId })

        if (response.ok) {
            this.etagManager.delete(key)
        }
    }

    async patch(
        id: StoreKey,
        patches: Patch[],
        metadata: PatchMetadata,
        extraHeaders?: Record<string, string>,
        debug?: { emitter: DebugEmitter; requestId?: string }
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
        const payloadBytes = debug ? utf8ByteLength(JSON.stringify(body)) : undefined
        const startedAt = debug ? Date.now() : 0
        debug?.emitter.emit('adapter:request', {
            method: 'POST',
            endpoint,
            attempt: 1,
            payloadBytes
        }, { requestId: debug.requestId })

        const response = await sendJson(
            this.sender,
            url,
            body,
            headers
        )

        debug?.emitter.emit('adapter:response', {
            ok: response.ok,
            status: response.status,
            durationMs: Date.now() - startedAt
        }, { requestId: debug.requestId })

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
        debug?: { emitter: DebugEmitter; requestId?: string }
    ): Promise<void> {
        if (!this.config.endpoints.bulkUpdate) return
        const endpoint = resolveEndpoint(this.config.endpoints.bulkUpdate)
        const url = makeUrl(this.config.baseURL, endpoint)
        const headers = { ...(await this.getHeaders()), ...(extraHeaders || {}) }
        const body = { items }
        const payloadBytes = debug ? utf8ByteLength(JSON.stringify(body)) : undefined
        const startedAt = debug ? Date.now() : 0
        debug?.emitter.emit('adapter:request', {
            method: 'POST',
            endpoint,
            attempt: 1,
            payloadBytes
        }, { requestId: debug.requestId })
        const response = await sendJson(this.sender, url, body, headers)
        debug?.emitter.emit('adapter:response', {
            ok: response.ok,
            status: response.status,
            durationMs: Date.now() - startedAt
        }, { requestId: debug.requestId })
        if (!response.ok) {
            throw new Error(`Bulk update failed: ${response.status}`)
        }
    }

    async bulkCreate(
        items: T[],
        extraHeaders?: Record<string, string>,
        debug?: { emitter: DebugEmitter; requestId?: string }
    ): Promise<T[] | undefined> {
        if (!this.config.endpoints.bulkCreate) return
        const endpoint = resolveEndpoint(this.config.endpoints.bulkCreate)
        const url = makeUrl(this.config.baseURL, endpoint)
        const headers = { ...(await this.getHeaders()), ...(extraHeaders || {}) }
        const body = { items }
        const payloadBytes = debug ? utf8ByteLength(JSON.stringify(body)) : undefined
        const startedAt = debug ? Date.now() : 0
        debug?.emitter.emit('adapter:request', {
            method: 'POST',
            endpoint,
            attempt: 1,
            payloadBytes
        }, { requestId: debug.requestId })
        const response = await sendJson(this.sender, url, body, headers)
        debug?.emitter.emit('adapter:response', {
            ok: response.ok,
            status: response.status,
            durationMs: Date.now() - startedAt
        }, { requestId: debug.requestId })
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
        debug?: { emitter: DebugEmitter; requestId?: string }
    ): Promise<void> {
        if (!this.config.endpoints.bulkDelete) return
        const endpoint = resolveEndpoint(this.config.endpoints.bulkDelete)
        const url = makeUrl(this.config.baseURL, endpoint)
        const headers = { ...(await this.getHeaders()), ...(extraHeaders || {}) }
        const body = { ids: keys }
        const payloadBytes = debug ? utf8ByteLength(JSON.stringify(body)) : undefined
        const startedAt = debug ? Date.now() : 0
        debug?.emitter.emit('adapter:request', {
            method: 'POST',
            endpoint,
            attempt: 1,
            payloadBytes
        }, { requestId: debug.requestId })
        const response = await sendJson(this.sender, url, body, headers)
        debug?.emitter.emit('adapter:response', {
            ok: response.ok,
            status: response.status,
            durationMs: Date.now() - startedAt
        }, { requestId: debug.requestId })
        if (!response.ok) {
            throw new Error(`Bulk delete failed: ${response.status}`)
        }
        keys.forEach(k => this.etagManager.delete(k))
    }
}
