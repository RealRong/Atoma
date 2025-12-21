import { Patch } from 'immer'
import { PatchMetadata, StoreKey } from '../../core/types'
import type { HTTPAdapterConfig } from './config/types'

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
    version?: import('./config/types').VersionConfig
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

function unwrapConflictPayload(serverPayload: any): any {
    if (!serverPayload || typeof serverPayload !== 'object') return serverPayload
    const p: any = serverPayload
    const details = p?.error && typeof p.error === 'object' ? (p.error as any).details : undefined
    if (!details || typeof details !== 'object') return serverPayload
    return {
        ...p,
        ...details,
        currentValue: (details as any).currentValue ?? p.currentValue,
        currentVersion: (details as any).currentVersion ?? p.currentVersion
    }
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

    const conflictPayload = unwrapConflictPayload(serverPayload)

    if (config.onConflict) {
        const decision = await config.onConflict({
            key,
            local: localValue,
            server: conflictPayload,
            metadata
        })
        if (decision === 'retry-local') {
            const { value, etag } = mergeVersion(localValue as T, conflictPayload, headerEtag, config.version)
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
            const serverUpdatedAt = conflictPayload?.currentValue?.updatedAt ?? conflictPayload?.updatedAt
            if (localUpdatedAt && serverUpdatedAt && localUpdatedAt > serverUpdatedAt) {
                const { value, etag } = mergeVersion(localValue as T, conflictPayload, headerEtag, config.version)
                if (etag) {
                    config.onEtagExtracted?.(key, etag)
                }
                await sendPut(key, value)
            } else {
                config.onResolved?.(conflictPayload, key)
            }
            break
        }
        case 'server-wins':
            config.onResolved?.(conflictPayload, key)
            break
        case 'manual':
        default:
            break
    }
}
