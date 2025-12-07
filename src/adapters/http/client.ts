import { StoreKey, PatchMetadata } from '../../core/types'
import { Patch } from 'immer'
import { ETagManager } from './etagManager'
import { makeUrl, sendJson, sendDelete, sendPutJson, RequestSender, resolveEndpoint } from './request'
import type { VersionConfig } from '../HTTPAdapter'

export interface ClientConfig {
    baseURL: string
    endpoints: {
        create: string | (() => string)
        update: string | ((id: StoreKey) => string)
        delete: string | ((id: StoreKey) => string)
        patch?: string | ((id: StoreKey) => string)
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

    async put(key: StoreKey, value: T): Promise<void> {
        const url = makeUrl(this.config.baseURL, resolveEndpoint(this.config.endpoints.update, key))
        const headers = await this.getHeaders()

        this.etagManager.attachVersion(headers, this.config.version, value, key)

        const response = await sendPutJson(this.sender, url, value, headers)

        if (response.status === 409) {
            await this.conflictHandler.handle(response, key, value)
            return
        }

        const newEtag = this.etagManager.extractFromResponse(response)
        if (newEtag) {
            this.etagManager.set(key, newEtag)
        }
    }

    async create(key: StoreKey, value: T): Promise<void> {
        const url = makeUrl(this.config.baseURL, resolveEndpoint(this.config.endpoints.create))
        const headers = await this.getHeaders()

        this.etagManager.attachVersion(headers, this.config.version, value, key)

        const body = (() => {
            if (value && typeof value === 'object') {
                return { ...value, id: key }
            }
            return { id: key, value }
        })()

        const response = await sendJson(this.sender, url, body, headers)

        const etag = this.etagManager.extractFromResponse(response)
        if (etag) {
            this.etagManager.set(key, etag)
        }
    }

    async delete(key: StoreKey): Promise<void> {
        const url = makeUrl(this.config.baseURL, resolveEndpoint(this.config.endpoints.delete, key))
        const headers = await this.getHeaders()

        this.etagManager.attachVersion(headers, this.config.version, undefined, key)

        const response = await sendDelete(this.sender, url, headers)

        if (response.ok) {
            this.etagManager.delete(key)
        }
    }

    async patch(id: StoreKey, patches: Patch[], metadata: PatchMetadata): Promise<void> {
        const patchEndpoint = this.config.endpoints.patch || this.config.endpoints.update
        const url = makeUrl(this.config.baseURL, resolveEndpoint(patchEndpoint, id))
        const headers = await this.getHeaders()

        this.etagManager.attachVersion(headers, this.config.version, metadata)

        const response = await sendJson(
            this.sender,
            url,
            {
                patches,
                baseVersion: metadata.baseVersion,
                timestamp: metadata.timestamp
            },
            headers
        )

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

    async bulkUpdate(items: T[]): Promise<void> {
        if (!this.config.endpoints.bulkUpdate) return
        const url = makeUrl(this.config.baseURL, resolveEndpoint(this.config.endpoints.bulkUpdate))
        const headers = await this.getHeaders()
        const response = await sendJson(this.sender, url, { items }, headers)
        if (!response.ok) {
            throw new Error(`Bulk update failed: ${response.status}`)
        }
    }

    async bulkDelete(keys: StoreKey[]): Promise<void> {
        if (!this.config.endpoints.bulkDelete) return
        const url = makeUrl(this.config.baseURL, resolveEndpoint(this.config.endpoints.bulkDelete))
        const headers = await this.getHeaders()
        const response = await sendJson(this.sender, url, { ids: keys }, headers)
        if (!response.ok) {
            throw new Error(`Bulk delete failed: ${response.status}`)
        }
        keys.forEach(k => this.etagManager.delete(k))
    }
}
