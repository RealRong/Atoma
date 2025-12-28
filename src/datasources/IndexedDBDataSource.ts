import { Table } from 'dexie'
import { Patch } from 'immer'
import type { IDataSource, PatchMetadata, StoreKey, FindManyOptions, PageInfo, Entity } from '#core'
import { Core } from '#core'

/**
 * IndexedDB DataSource using Dexie
 */
export class IndexedDBDataSource<T extends Entity> implements IDataSource<T> {
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

    async getAll(filter?: ((item: T) => boolean) | unknown): Promise<T[]> {
        const items = await this.table.toArray()
        const shouldFilter = typeof filter === 'function'
        let result = shouldFilter ? items.filter(filter as (item: T) => boolean) : items

        if (this.options?.transformData) {
            const mapped = result.map(item => this.options!.transformData!(item) as T | undefined)
            result = mapped.filter((item): item is T => item !== undefined)
        }

        return result
    }

    async findMany(options?: FindManyOptions<T>): Promise<{ data: T[]; pageInfo?: PageInfo }> {
        // Fast path: 仅在满足「无复杂 where」且按 id 排序/默认排序时，使用 Dexie 游标分页提升性能
        const canFastPath =
            (!options?.where || Object.keys(options.where).length === 0) &&
            (!options?.orderBy ||
                (!Array.isArray(options.orderBy) && (options.orderBy as any).field === 'id'))

        if (canFastPath) {
            try {
                const dir = options?.orderBy && !Array.isArray(options.orderBy)
                    ? options.orderBy.direction
                    : 'asc'
                const limit = options?.limit
                const offset = options?.offset ?? 0
                const cursor = options?.cursor

                // 基于主键 id 的游标分页
                let coll = this.table.orderBy('id')
                if (dir === 'desc') {
                    coll = coll.reverse()
                }

                if (cursor !== undefined && cursor !== null) {
                    if (dir === 'desc') {
                        coll = this.table.where('id').below(cursor).reverse()
                    } else {
                        coll = this.table.where('id').above(cursor)
                    }
                }

                if (offset) {
                    coll = coll.offset(offset)
                }
                if (limit !== undefined) {
                    coll = coll.limit(limit)
                }

                const raw = await coll.toArray()
                const data = this.options?.transformData
                    ? raw.map(i => this.options!.transformData!(i)).filter((i): i is T => i !== undefined)
                    : raw

                const last = data[data.length - 1]
                const hasNext = limit !== undefined ? data.length === limit : false
                return {
                    data,
                    pageInfo: {
                        cursor: last ? String((last as any).id) : cursor ? String(cursor) : undefined,
                        hasNext,
                        total: undefined // fast path 不计算 total，避免全表扫描
                    }
                }
            } catch {
                // 如果索引不存在或查询失败，回退到通用路径
            }
        }

        // 通用回退路径：取全量再应用本地过滤/排序
        const items = await this.table.toArray()
        const transformed = this.options?.transformData
            ? items.map(i => this.options!.transformData!(i)).filter((i): i is T => i !== undefined)
            : items

        // applyQuery handles where/orderBy/limit/offset
        const filtered = Core.query.applyQuery(transformed as any, options) as T[]

        // cursor 分页（通用路径）：按结果集位置切片
        const sliceStart = options?.cursor
            ? filtered.findIndex(item => String((item as any).id) === String(options.cursor)) + 1
            : (options?.offset || 0)

        const limit = options?.limit
        const sliceEnd = limit ? sliceStart + limit : filtered.length

        if (sliceStart === 0 && !limit) return { data: filtered }

        const pageData = filtered.slice(sliceStart, sliceEnd)

        // Generate next cursor
        const lastItem = pageData[pageData.length - 1]
        const nextCursor = lastItem ? (lastItem as any).id : undefined
        const hasNext = sliceEnd < filtered.length

        return {
            data: pageData,
            pageInfo: {
                cursor: nextCursor ? String(nextCursor) : undefined,
                hasNext,
                total: filtered.length
            }
        }
    }

    async applyPatches(patches: Patch[], metadata: PatchMetadata): Promise<void> {
        const putActions: T[] = []
        const deleteKeys: number[] = []

        patches.forEach(patch => {
            if (patch.op === 'add' || patch.op === 'replace') {
                const value = this.serializeValue(patch.value)
                putActions.push(value)
            } else if (patch.op === 'remove') {
                deleteKeys.push(patch.path[0] as number)
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
        console.error(`[IndexedDBDataSource:${this.name}] Error in ${operation}:`, error)
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
