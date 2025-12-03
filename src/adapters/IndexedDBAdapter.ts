import { Table } from 'dexie'
import { Patch } from 'immer'
import { IAdapter, PatchMetadata, StoreKey } from '../core/types'

/**
 * IndexedDB Adapter using Dexie
 */
export class IndexedDBAdapter<T> implements IAdapter<T> {
    public readonly name: string

    constructor(
        private table: Table<T, StoreKey>,
        private options?: {
            transformData?: (data: T) => T | undefined
        }
    ) {
        this.name = table.name
    }

    async put(key: number, value: T): Promise<void> {
        const serialized = this.serializeValue(value)
        await this.table.put(serialized, key)
    }

    async bulkPut(items: T[]): Promise<void> {
        const serialized = items.map(item => this.serializeValue(item))
        await this.table.bulkPut(serialized)
    }

    async delete(key: number): Promise<void> {
        await this.table.delete(key)
    }

    async bulkDelete(keys: number[]): Promise<void> {
        await this.table.bulkDelete(keys)
    }

    async get(key: number): Promise<T | undefined> {
        const item = await this.table.get(key)
        if (!item) return undefined
        return this.options?.transformData ? this.options.transformData(item) : item
    }

    async bulkGet(keys: number[]): Promise<(T | undefined)[]> {
        const items = await this.table.bulkGet(keys)
        return items.map(item => {
            if (!item) return undefined
            return this.options?.transformData ? this.options.transformData(item) : item
        })
    }

    async getAll(filter?: (item: T) => boolean): Promise<T[]> {
        const items = await this.table.toArray()
        let result = filter ? items.filter(filter) : items

        if (this.options?.transformData) {
            const mapped = result.map(item => this.options!.transformData!(item) as T | undefined)
            result = mapped.filter((item): item is T => item !== undefined)
        }

        return result
    }

    async applyPatches(patches: Patch[], metadata: PatchMetadata): Promise<void> {
        const putActions: T[] = []
        const deleteKeys: number[] = []

        patches.forEach(patch => {
            if (patch.op === 'add' || patch.op === 'replace') {
                const value = this.serializeValue(patch.value)
                putActions.push(value)
            } else if (patch.op === 'remove') {
                deleteKeys.push(patch.path[0] as StoreKey)
            }
        })

        if (putActions.length) {
            await this.table.bulkPut(putActions)
        }
        if (deleteKeys.length) {
            await this.table.bulkDelete(deleteKeys)
        }
    }

    async onConnect(): Promise<void> {
        // Dexie connects automatically
    }

    onDisconnect(): void {
        // Dexie disconnects automatically
    }

    onError(error: Error, operation: string): void {
        console.error(`[IndexedDBAdapter:${this.name}] Error in ${operation}:`, error)
    }

    /**
     * Serialize value for IndexedDB storage
     * Converts Map/Set to arrays
     */
    private serializeValue(value: any): T {
        const cloned = { ...value }

        // Recursively convert Map/Set to arrays
        const iterate = (obj: any) => {
            const stack = [obj]
            while (stack.length > 0) {
                const currentObj = stack.pop()
                if (!currentObj || typeof currentObj !== 'object') continue

                Object.keys(currentObj).forEach(key => {
                    if (currentObj[key] instanceof Map) {
                        currentObj[key] = Array.from(currentObj[key].values())
                    } else if (currentObj[key] instanceof Set) {
                        currentObj[key] = Array.from(currentObj[key])
                    } else if (typeof currentObj[key] === 'object' && currentObj[key] !== null) {
                        stack.push(currentObj[key])
                    }
                })
            }
        }

        iterate(cloned)
        return cloned as T
    }
}
