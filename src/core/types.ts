import { Atom, PrimitiveAtom } from 'jotai'
import { Patch } from 'immer'
import type { StoreContext } from './StoreContext'

/**
 * Base key type for entities
 */
export type StoreKey = string | number

/**
 * Minimal entity interface - all stored entities must have an id
 */
export interface Entity {
    id: StoreKey
}

/**
 * Base interface for all entities stored in the sync engine
 */
export interface IBase extends Entity {
    createdAt: number
    updatedAt: number
    deleted?: boolean
    deletedAt?: number
    version?: number      // Optional: for optimistic locking
    _etag?: string        // Optional: HTTP ETag for conflict detection
}

/**
 * Partial type with required id field
 */
export type PartialWithId<T> = Partial<T> & { id: StoreKey }

/**
 * Adapter interface - abstracts the storage backend
 */
export interface IAdapter<T extends Entity> {
    /** Adapter name for debugging */
    name: string

    /**  
     * Persistence operations
     */
    put(key: StoreKey, value: T): Promise<void>
    bulkPut(items: T[]): Promise<void>
    delete(key: StoreKey): Promise<void>
    bulkDelete(keys: StoreKey[]): Promise<void>

    /**
     * Retrieval operations
     */
    get(key: StoreKey): Promise<T | undefined>
    bulkGet(keys: StoreKey[]): Promise<(T | undefined)[]>
    getAll(filter?: (item: T) => boolean): Promise<T[]>

    /**
     * Patch-based update (optional, falls back to put) 
     */
    applyPatches?(patches: Patch[], metadata: PatchMetadata): Promise<void>

    /**
     * Lifecycle hooks
     */
    onConnect?(): Promise<void>
    onDisconnect?(): void

    /**
     * Error handling
     */
    onError?(error: Error, operation: string): void
}

/**
 * Metadata passed with patch operations
 */
export interface PatchMetadata {
    atom: Atom<any>
    databaseName?: string
    timestamp: number
    baseVersion?: number
    etag?: string         // Optional: ETag for HTTP conflict detection
}

/**
 * Dispatch event for queue processing
 */
export type StoreDispatchEvent<T extends Entity> = {
    atom: PrimitiveAtom<Map<StoreKey, T>>
    data: PartialWithId<T>
    adapter: IAdapter<T>
    store?: JotaiStore // Jotai store instance
    context?: StoreContext // StoreContext for per-store dependencies (avoids circular import)
    onFail?: (error?: Error) => void  // Accept error object for rejection
} & (
        | {
            type: 'add'
            onSuccess?: (o: T) => void
        }
        | {
            type: 'update'
            transformData?: (o: T) => T | undefined
            onSuccess?: (o: T) => void
        }
        | {
            type: 'remove'
            clearCache?: boolean
            onSuccess?: () => void
        }
        | {
            type: 'forceRemove'
            onSuccess?: () => void
        }
    )

/**
 * Options for store operations
 */
export interface StoreOperationOptions {
    force?: boolean
    clearCache?: boolean
}

export type WhereOperator<T> = Partial<Record<keyof T & string, any | {
    in?: any[]
    gt?: number
    gte?: number
    lt?: number
    lte?: number
    startsWith?: string
    endsWith?: string
    contains?: string
}>>

export type OrderBy<T> =
    | { field: keyof T & string, direction: 'asc' | 'desc' }
    | Array<{ field: keyof T & string, direction: 'asc' | 'desc' }>

export type FetchPolicy = 'local' | 'remote' | 'local-then-remote'

export type PageInfo = { cursor?: string; hasNext?: boolean; total?: number }

export interface FindManyOptions<T> {
    where?: WhereOperator<T>
    orderBy?: OrderBy<T>
    limit?: number
    offset?: number
    cursor?: string
    cache?: {
        key?: string
        tags?: string[]
        staleTime?: number
    }
    /** If true, fetched data will NOT be stored in the central atom or indexed. Use for high-volume read-only data. */
    skipStore?: boolean
}

export type FindManyResult<T> = T[] | { data: T[]; pageInfo?: PageInfo }

/**
 * Schema validator support (works with Zod/Yup or custom functions)
 */
export type SchemaValidator<T> =
    | ((data: T) => T | Promise<T>)
    | {
        parse: (data: unknown) => T
    }
    | {
        safeParse: (data: unknown) => { success: boolean; data: T; error?: unknown }
    }
    | {
        validateSync: (data: unknown) => T
    }
    | {
        validate: (data: unknown) => Promise<T> | T
    }

export interface LifecycleHooks<T> {
    beforeSave?: (args: { action: 'add' | 'update'; item: PartialWithId<T> }) => PartialWithId<T> | Promise<PartialWithId<T>>
    afterSave?: (args: { action: 'add' | 'update'; item: PartialWithId<T> }) => void | Promise<void>
}

/**
 * Store configuration options
 */
export interface StoreConfig<T> {
    /** Transform data before storing in atom */
    transformData?: (item: T) => T

    /** Custom ID generator (defaults to Snowflake-like generator) */
    idGenerator?: () => StoreKey

    /** Custom Jotai store instance */
    store?: JotaiStore  // ReturnType<typeof createStore> from 'jotai'

    /** Optional schema validator (zod/yup/custom) */
    schema?: SchemaValidator<T>

    /** Lifecycle hooks for add/update */
    hooks?: LifecycleHooks<T>

    /** Optional index definitions (for findMany 优先命中) */
    indexes?: Array<IndexDefinition<T>>

    /** Per-store context for dependency injection (avoids circular import) */
    context?: StoreContext
}

export type IndexType = 'number' | 'date' | 'string' | 'text'

export interface IndexDefinition<T> {
    field: keyof T & string
    type: IndexType
    options?: {
        minTokenLength?: number
        fuzzyDistance?: 0 | 1 | 2
        tokenizer?: (text: string) => string[]
    }
}

/**
 * Store interface - main API for CRUD operations
 */
export interface IStore<T> {
    /** Add a new item */
    addOne(item: Partial<T>, options?: StoreOperationOptions): Promise<T>

    /** Update an existing item */
    updateOne(item: PartialWithId<T>, options?: StoreOperationOptions): Promise<T>

    /** Delete an item by ID */
    deleteOneById(id: StoreKey, options?: StoreOperationOptions): Promise<boolean>

    /** Get one item by ID */
    getOneById(id: StoreKey, options?: StoreOperationOptions): Promise<T | undefined>

    /** Fetch one from backend (bypass cache) */
    fetchOneById(id: StoreKey): Promise<T | undefined>

    /** 
     * Get all items 
     * @param filter - Filter items from backend
     * @param cacheFilter - Only cache items matching this filter (optimization)
     */
    getAll(filter?: (item: T) => boolean, cacheFilter?: (item: T) => boolean): Promise<T[]>

    /** Fetch all from backend */
    fetchAll?(): Promise<T[]>

    /** Get multiple items by IDs */
    getMultipleByIds(ids: StoreKey[], cache?: boolean): Promise<T[]>

    /** Query with filtering/sorting/paging */
    findMany?(options?: FindManyOptions<T>): Promise<FindManyResult<T>>
}

export type UseFindManyResult<T> = {
    data: T[]
    loading: boolean
    error?: Error
    refetch: () => Promise<T[]>
    isStale: boolean
    pageInfo?: PageInfo
    /** Fetch more data (e.g. next page) and append/merge it. Used for infinite scroll. */
    fetchMore: (options: FindManyOptions<T>) => Promise<T[]>
}

/**
 * Optimistic mode configuration
 * - optimistic: UI updates immediately, adapter failures only rollback locally
 * - strict: UI updates only after adapter confirms success
 */
export type OptimisticMode = 'optimistic' | 'strict'

/**
 * Queue configuration
 */
export interface QueueConfig {
    /** Enable batch processing */
    enabled: boolean

    /** Success/failure mode (default: 'optimistic' for backward compatibility) */
    mode?: OptimisticMode

    /** Log queue operations */
    debug?: boolean
}

/**
 * History change record
 */
export interface HistoryChange {
    patches: Patch[]
    inversePatches: Patch[]
    atom: Atom<any>
    databaseName?: string
    timestamp: number
}

/**
 * Event emitter type
 */
export type EventHandler<T = any> = (data: T) => void

export interface IEventEmitter {
    on(event: string, handler: EventHandler): void
    off(event: string, handler: EventHandler): void
    emit(event: string, data?: any): void
}

/** Helper type alias for Jotai store to reduce `any` usage */
export type JotaiStore = ReturnType<typeof import('jotai').createStore>
