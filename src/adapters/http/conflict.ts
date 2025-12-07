import { Patch } from 'immer'
import { PatchMetadata, StoreKey } from '../../core/types'
import type { HTTPAdapterConfig } from '../HTTPAdapter'

export type ConflictResolution = 'last-write-wins' | 'server-wins' | 'manual'

type ConflictConfig<T> = {
    resolution?: ConflictResolution
    onConflict?: (args: {
        key: StoreKey
        local: T | Patch[]
        server: any
        metadata?: PatchMetadata
    }) => Promise<'accept-server' | 'retry-local' | 'ignore'> | 'accept-server' | 'retry-local' | 'ignore'
    onResolved?: (serverValue: any, key: StoreKey) => void
    version?: import('../HTTPAdapter').VersionConfig
    onEtagExtracted?: (key: StoreKey, etag: string) => void
}

/**
 * Merge version information from server into local value without polluting the object
 * @returns Tuple of [mergedValue, extractedEtag]
 */
function mergeVersion<T>(
    localValue: T,
    serverPayload: any,
    headerEtag?: string,
    version?: HTTPAdapterConfig<T>['version']
): { value: T; etag?: string } {
    if (!serverPayload || typeof localValue !== 'object' || localValue === null) {
        return { value: localValue, etag: headerEtag }
    }

    const nextValue: any = { ...(localValue as any) }
    const versionField = version?.field

    // Merge version field if present
    if (versionField && serverPayload?.[versionField] !== undefined) {
        nextValue[versionField] = serverPayload[versionField]
    }

    // Extract etag without polluting the object
    const etag = serverPayload?.etag || headerEtag

    return { value: nextValue as T, etag }
}

export async function resolveConflict<T>(
    response: Response,
    key: StoreKey,
    localValue: T | Patch[],
    config: ConflictConfig<T> & { onEtagExtracted?: (key: StoreKey, etag: string) => void },
    sendPut: (key: StoreKey, value: T) => Promise<void>,
    metadata?: PatchMetadata,
    serverData?: any,
    headerEtag?: string
): Promise<void> {
    const serverPayload =
        serverData ??
        (await (async () => {
            try {
                return await response.clone().json()
            } catch {
                return undefined
            }
        })())

    if (config.onConflict) {
        const decision = await config.onConflict({
            key,
            local: localValue,
            server: serverPayload,
            metadata
        })
        if (decision === 'retry-local') {
            const { value, etag } = mergeVersion(localValue as T, serverPayload, headerEtag, config.version)
            if (etag) {
                config.onEtagExtracted?.(key, etag)
            }
            await sendPut(key, value)
            return
        }
        if (decision === 'accept-server' || decision === 'ignore') {
            return
        }
    }

    switch (config.resolution) {
        case 'last-write-wins': {
            const localUpdatedAt = (localValue as any)?.updatedAt ?? metadata?.timestamp
            const serverUpdatedAt = serverPayload?.currentValue?.updatedAt ?? serverPayload?.updatedAt
            if (localUpdatedAt && serverUpdatedAt && localUpdatedAt > serverUpdatedAt) {
                const { value, etag } = mergeVersion(localValue as T, serverPayload, headerEtag, config.version)
                if (etag) {
                    config.onEtagExtracted?.(key, etag)
                }
                await sendPut(key, value)
            } else {
                config.onResolved?.(serverPayload, key)
            }
            break
        }
        case 'server-wins':
            config.onResolved?.(serverPayload, key)
            break
        case 'manual':
        default:
            break
    }
}
