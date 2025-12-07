import { StoreKey } from '../../core/types'

export interface VersionConfig {
    field?: string
    ifMatchHeader?: string
    cacheSize?: number
}

export class ETagManager {
    private cache: Map<StoreKey, string> = new Map()
    private readonly limit: number

    constructor(limit: number = 1000) {
        this.limit = limit
    }

    get(key: StoreKey): string | undefined {
        return this.cache.get(key)
    }

    set(key: StoreKey, etag: string): void {
        this.cache.set(key, etag)
        if (this.cache.size > this.limit) {
            const firstKey = this.cache.keys().next().value
            if (firstKey !== undefined) {
                this.cache.delete(firstKey)
            }
        }
    }

    delete(key: StoreKey): void {
        this.cache.delete(key)
    }

    clear(): void {
        this.cache.clear()
    }

    extractFromResponse(response: Response): string | undefined {
        return response.headers.get('ETag') || undefined
    }

    attachVersion(
        headers: Record<string, string>,
        versionConfig?: VersionConfig,
        payload?: any,
        key?: StoreKey
    ): void {
        if (!versionConfig) return

        if (versionConfig.ifMatchHeader) {
            // Check version field in payload first, then fall back to cached ETag
            let etag: string | undefined
            if (payload && versionConfig.field && (payload as any)[versionConfig.field] !== undefined) {
                etag = String((payload as any)[versionConfig.field])
            } else if (key !== undefined) {
                etag = this.cache.get(key)
            }
            if (etag) {
                headers[versionConfig.ifMatchHeader] = etag
            }
        } else if (versionConfig.field && payload && (payload as any)[versionConfig.field] !== undefined) {
            headers['If-Match'] = String((payload as any)[versionConfig.field])
        }
    }
}
