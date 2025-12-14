import { Patch } from 'immer'
import { IAdapter, PatchMetadata, StoreKey, Entity } from '../core/types'

/**
 * Hybrid adapter configuration
 */
export interface HybridAdapterConfig<T extends Entity> {
    /** Local adapter (fast cache) */
    local: IAdapter<T>

    /** Remote adapter (authoritative source) */
    remote: IAdapter<T>

    /** Strategy configuration */
    strategy?: {
        /** Read strategy */
        read?: 'local-first' | 'remote-first' | 'local-only' | 'remote-only'

        /** Write strategy */
        write?: 'local-first' | 'remote-first' | 'both' | 'local-only' | 'remote-only'

        /** Cache invalidation time (ms) */
        cacheTimeout?: number

        /** Sync deleted items to remote */
        syncDeletes?: boolean
    }

    /** Optional events for UI/observability */
    events?: {
        onSyncStart?: (count: number) => void
        onSyncComplete?: (remaining: number) => void
        onError?: (error: Error, operation: string) => void
    }
}

/**
 * HybridAdapter - Combines local cache with remote storage
 * 
 * Features:
 * - Read-through cache (local first, fallback to remote)
 * - Write-through pattern (remote + local)
 * - Offline fallback (local-only when remote fails)
 * - Automatic cache synchronization
 */
export class HybridAdapter<T extends Entity> implements IAdapter<T> {
    public readonly name: string
    private config: Required<HybridAdapterConfig<T>>
    private lastSyncTime = new Map<StoreKey, number>()
    private isRefreshingAll = false

    constructor(config: HybridAdapterConfig<T>) {
        this.name = `Hybrid(${config.local.name}+${config.remote.name})`

        // Set defaults
        this.config = {
            ...config,
            strategy: {
                read: config.strategy?.read || 'local-first',
                write: config.strategy?.write || 'remote-first',
                // Default cache timeout to 5 minutes to avoid stale forever
                cacheTimeout: config.strategy?.cacheTimeout ?? 5 * 60 * 1000,
                syncDeletes: config.strategy?.syncDeletes ?? true
            },
            events: config.events || {} // Ensure events is always an object
        } as Required<HybridAdapterConfig<T>>
    }

    async get(key: StoreKey): Promise<T | undefined> {
        const { read } = this.config.strategy

        switch (read) {
            case 'local-first':
                return this.getLocalFirst(key)

            case 'remote-first':
                return this.getRemoteFirst(key)

            case 'local-only':
                return this.config.local.get(key)

            case 'remote-only':
                return this.config.remote.get(key)

            default:
                return this.getLocalFirst(key)
        }
    }

    async bulkGet(keys: StoreKey[]): Promise<(T | undefined)[]> {
        const { read } = this.config.strategy

        if (read === 'local-only') {
            return this.config.local.bulkGet(keys)
        }

        if (read === 'remote-only') {
            return this.config.remote.bulkGet(keys)
        }

        // For local-first/remote-first, try local first
        const localResults = await this.config.local.bulkGet(keys)

        // Find missing keys
        const missingIndices: number[] = []
        const missingKeys: StoreKey[] = []

        localResults.forEach((result, index) => {
            if (!result) {
                missingIndices.push(index)
                missingKeys.push(keys[index])
            }
        })

        // Fetch missing from remote
        if (missingKeys.length > 0) {
            const remoteResults = await this.config.remote.bulkGet(missingKeys)

            // Cache fetched items
            const itemsToCache = remoteResults.filter((item): item is T => item !== undefined)
            if (itemsToCache.length > 0) {
                await this.config.local.bulkPut(itemsToCache)
                this.recordSyncTimes(itemsToCache)
            }

            // Merge results
            missingIndices.forEach((localIndex, remoteIndex) => {
                localResults[localIndex] = remoteResults[remoteIndex]
            })
        }

        return localResults
    }

    async getAll(filter?: (item: T) => boolean): Promise<T[]> {
        const { read } = this.config.strategy

        if (read === 'local-only') {
            return this.config.local.getAll(filter)
        }

        if (read === 'remote-only') {
            try {
                const remote = await this.config.remote.getAll(filter)
                this.recordSyncTimes(remote)
                return remote
            } catch (error) {
                this.config.remote.onError?.(error as Error, 'getAll')
                this.emitError(error as Error, 'getAll')
                return []
            }
        }

        // For hybrid modes, prefer local but refresh from remote in background
        const localData = await this.config.local.getAll(filter)

        // Background refresh from remote (don't await)
        if (read === 'local-first') {
            this.refreshFromRemote(filter).catch(error => {
                this.config.local.onError?.(error, 'background-refresh')
                this.emitError(error as Error, 'background-refresh')
            })
        }

        return localData
    }

    async put(key: StoreKey, value: T): Promise<void> {
        const { write } = this.config.strategy

        switch (write) {
            case 'remote-first':
                await this.putRemoteFirst(key, value)
                break

            case 'local-first':
                await this.putLocalFirst(key, value)
                break

            case 'both':
                await Promise.all([
                    this.config.remote.put(key, value),
                    this.config.local.put(key, value)
                ])
                break

            case 'local-only':
                await this.config.local.put(key, value)
                break

            case 'remote-only':
                await this.config.remote.put(key, value)
                break
        }

        this.lastSyncTime.set(key, Date.now())
    }

    async bulkPut(items: T[]): Promise<void> {
        const { write } = this.config.strategy

        if (write === 'both') {
            await Promise.all([
                this.config.remote.bulkPut(items),
                this.config.local.bulkPut(items)
            ])
        } else if (write === 'remote-first') {
            try {
                await this.config.remote.bulkPut(items)
                await this.config.local.bulkPut(items)
            } catch (error) {
                // Fallback to local on remote failure
                await this.config.local.bulkPut(items)
                this.emitError(error as Error, 'bulkPut')
                throw error
            }
        } else if (write === 'local-first') {
            await this.config.local.bulkPut(items)
            try {
                await this.config.remote.bulkPut(items)
            } catch (error) {
                this.config.remote.onError?.(error as Error, 'bulkPut')
                this.emitError(error as Error, 'bulkPut')
            }
        } else if (write === 'local-only') {
            await this.config.local.bulkPut(items)
        } else {
            await this.config.remote.bulkPut(items)
        }
    }

    async delete(key: StoreKey): Promise<void> {
        const { write, syncDeletes } = this.config.strategy

        if (write === 'local-only' || !syncDeletes) {
            await this.config.local.delete(key)
            return
        }

        if (write === 'remote-only') {
            await this.config.remote.delete(key)
            return
        }

        // For other strategies, delete from both
        await Promise.all([
            this.config.local.delete(key),
            syncDeletes ? this.config.remote.delete(key) : Promise.resolve()
        ])

        this.lastSyncTime.delete(key)
    }

    async bulkDelete(keys: StoreKey[]): Promise<void> {
        const { syncDeletes } = this.config.strategy

        await Promise.all([
            this.config.local.bulkDelete(keys),
            syncDeletes ? this.config.remote.bulkDelete(keys) : Promise.resolve()
        ])

        keys.forEach(key => this.lastSyncTime.delete(key))
    }

    async applyPatches(patches: Patch[], metadata: PatchMetadata): Promise<void> {
        const { write } = this.config.strategy
        const local = this.config.local
        const remote = this.config.remote

        // Apply patches to both adapters
        const promises: Promise<void>[] = []

        if (write !== 'remote-only') {
            if (local.applyPatches) {
                promises.push(local.applyPatches(patches, metadata).then(() => undefined))
            } else {
                promises.push(this.applyPatchesViaOperations(this.config.local, patches))
            }
        }

        if (write !== 'local-only') {
            if (remote.applyPatches) {
                promises.push(remote.applyPatches(patches, metadata).then(() => undefined))
            } else {
                promises.push(this.applyPatchesViaOperations(this.config.remote, patches))
            }
        }

        if (write === 'remote-first') {
            // Execute remote first, then local
            await promises[1]  // remote
            await promises[0]  // local
        } else {
            // Execute in parallel
            await Promise.all(promises)
        }
    }

    async onConnect(): Promise<void> {
        await Promise.all([
            this.config.local.onConnect?.(),
            this.config.remote.onConnect?.()
        ])
    }

    onDisconnect(): void {
        this.config.local.onDisconnect?.()
        this.config.remote.onDisconnect?.()
    }

    onError(error: Error, operation: string): void {
        console.error(`[HybridAdapter] Error in ${operation}:`, error)
        this.config.local.onError?.(error, operation)
        this.config.remote.onError?.(error, operation)
    }

    /**
     * Get with local-first strategy
     */
    private async getLocalFirst(key: StoreKey): Promise<T | undefined> {
        const local = this.config.local
        const remote = this.config.remote
        // 1. Try local cache first
        let item = await local.get(key)

        // 2. Check if cache is valid
        const lastSync = this.lastSyncTime.get(key)
        const cacheAge = lastSync ? Date.now() - lastSync : Infinity

        if (item && cacheAge < this.config.strategy.cacheTimeout!) {
            return item  // Cache hit and valid
        }

        // 3. Cache miss or expired, fetch from remote
        try {
            item = await remote.get(key)

            if (item) {
                // 4. Update local cache
                await this.config.local.put(key, item)
                this.lastSyncTime.set(key, Date.now())
            }
        } catch (error) {
            this.config.remote.onError?.(error as Error, 'get')
            this.emitError(error as Error, 'get')
            // Return stale cache on remote failure
            if (item) return item
        }

        return item
    }

    /**
     * Get with remote-first strategy
     */
    private async getRemoteFirst(key: StoreKey): Promise<T | undefined> {
        const local = this.config.local
        const remote = this.config.remote
        try {
            // 1. Fetch from remote
            const item = await remote.get(key)

            if (item) {
                // 2. Update local cache
                await this.config.local.put(key, item)
                this.lastSyncTime.set(key, Date.now())
            }

            return item
        } catch (error) {
            this.config.remote.onError?.(error as Error, 'get')
            this.emitError(error as Error, 'get')

            // 3. Fallback to local cache
            return local.get(key)
        }
    }

    /**
     * Put with remote-first strategy (write-through)
     */
    private async putRemoteFirst(key: StoreKey, value: T): Promise<void> {
        try {
            // 1. Write to remote first (authoritative)
            await this.config.remote.put(key, value)

            // 2. Update local cache
            await this.config.local.put(key, value)
        } catch (error) {
            // 3. On remote failure, write to local only
            await this.config.local.put(key, value)
            this.emitError(error as Error, 'put')
            throw error
        }
    }

    /**
     * Put with local-first strategy
     */
    private async putLocalFirst(key: StoreKey, value: T): Promise<void> {
        // 1. Write to local immediately
        await this.config.local.put(key, value)

        // 2. Try to sync to remote (best effort)
        try {
            await this.config.remote.put(key, value)
        } catch (error) {
            this.config.remote.onError?.(error as Error, 'put')
            this.emitError(error as Error, 'put')
            // Don't throw, local write succeeded
        }
    }

    /**
     * Background refresh from remote
     */
    private async refreshFromRemote(filter?: (item: T) => boolean): Promise<void> {
        if (this.isRefreshingAll) return
        this.isRefreshingAll = true
        this.emitSyncStart()
        try {
            const remoteData = await this.config.remote.getAll(filter)
            await this.config.local.bulkPut(remoteData)
            const now = Date.now()
            remoteData.forEach(item => {
                const id = (item as any)?.id
                if (id !== undefined) {
                    this.lastSyncTime.set(id, now)
                }
            })
        } catch (error) {
            // Ignore errors in background refresh
            this.emitError(error as Error, 'background-refresh')
        } finally {
            this.isRefreshingAll = false
            this.emitSyncComplete()
        }
    }

    /**
     * Fallback: apply patches via put/delete operations
     */
    private async applyPatchesViaOperations(
        adapter: IAdapter<T>,
        patches: Patch[]
    ): Promise<void> {
        const putActions: T[] = []
        const deleteKeys: StoreKey[] = []

        patches.forEach(patch => {
            if (patch.op === 'add' || patch.op === 'replace') {
                putActions.push(patch.value as T)
            } else if (patch.op === 'remove') {
                deleteKeys.push(patch.path[0] as StoreKey)
            }
        })

        if (putActions.length) {
            await adapter.bulkPut(putActions)
        }
        if (deleteKeys.length) {
            await adapter.bulkDelete(deleteKeys)
        }
    }

    private recordSyncTimes(items: T[]) {
        const now = Date.now()
        items.forEach(item => {
            const id = (item as any)?.id
            if (id !== undefined) {
                this.lastSyncTime.set(id, now)
            }
        })
    }

    private emitSyncStart() {
        this.config.events?.onSyncStart?.(this.lastSyncTime.size)
    }

    private emitSyncComplete() {
        this.config.events?.onSyncComplete?.(this.lastSyncTime.size)
    }

    private emitError(error: Error, operation: string) {
        this.config.events?.onError?.(error, operation)
    }
}
