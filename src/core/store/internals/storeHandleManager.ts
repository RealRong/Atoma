import type { PrimitiveAtom } from 'jotai/vanilla'
import { StoreIndexes } from '../../indexes/StoreIndexes'
import type {
    CoreRuntime,
    Entity,
    IndexDefinition,
    JotaiStore,
    StoreApi,
    StoreConfig,
    StoreOperationOptions,
    StoreReadOptions
} from '../../types'
import type { EntityId } from '#protocol'
import type { QueryMatcherOptions } from '../../query/QueryMatcher'
import type { ObservabilityContext } from '#observability'
import type { StoreHandle } from './handleTypes'

const REGISTRY_KEY = Symbol.for('atoma.storeHandleRegistry')
const HANDLE_KEY = Symbol.for('atoma.storeHandle')
const RUNTIME_REGISTRY_KEY = Symbol.for('atoma.storeRuntimeRegistry')
const RUNTIME_KEY = Symbol.for('atoma.storeRuntime')

type StoreSnapshot<T extends Entity> = ReadonlyMap<EntityId, T>

export class StoreHandleManager {
    createStoreHandle<T extends Entity>(params: {
        atom: PrimitiveAtom<Map<EntityId, T>>
        jotaiStore: JotaiStore
        config: StoreConfig<T> & {
            storeName: string
        }
    }): StoreHandle<T> {
        const { atom, config, jotaiStore } = params
        const storeName = config.storeName || 'store'

        const indexes = config.indexes && config.indexes.length ? new StoreIndexes<T>(config.indexes) : null
        const matcher = this.buildQueryMatcherOptions(config.indexes)

        let opSeq = 0
        const nextOpId = (prefix: 'q' | 'w') => {
            opSeq += 1
            return `${prefix}_${Date.now()}_${opSeq}`
        }

        return {
            atom,
            jotaiStore,
            storeName,
            indexes,
            matcher,
            hooks: config.hooks,
            idGenerator: config.idGenerator,
            dataProcessor: config.dataProcessor,
            nextOpId,
            writePolicies: {
                allowImplicitFetchForWrite: true
            }
        }
    }

    resolveObservabilityContext<T extends Entity>(
        clientRuntime: CoreRuntime,
        handle: StoreHandle<T>,
        options?: StoreOperationOptions | StoreReadOptions | { explain?: boolean }
    ): ObservabilityContext {
        const anyOptions = options as any
        return clientRuntime.createObservabilityContext(handle.storeName, {
            explain: anyOptions?.explain === true
        })
    }

    attachStoreHandle<T extends Entity, Relations>(store: StoreApi<T, Relations>, handle: StoreHandle<T>): void {
        this.registerStoreHandle(store, handle)
        const anyStore: any = store as any
        if (anyStore && typeof anyStore === 'object') {
            anyStore[HANDLE_KEY] = handle
        }
    }

    attachStoreRuntime<T extends Entity, Relations>(store: StoreApi<T, Relations>, runtime: CoreRuntime): void {
        this.registerStoreRuntime(store, runtime)
        const anyStore: any = store as any
        if (anyStore && typeof anyStore === 'object') {
            anyStore[RUNTIME_KEY] = runtime
        }
    }

    getStoreHandle<T extends Entity>(store: StoreApi<T, any> | undefined): StoreHandle<T> | null {
        return this.resolveStoreHandle(store)
    }

    requireStoreHandle<T extends Entity>(store: StoreApi<T, any>, tag: string): StoreHandle<T> {
        const handle = this.resolveStoreHandle(store, tag)
        if (!handle) throw this.buildMissingHandleError(tag)
        return handle
    }

    getStoreRuntime<T extends Entity>(store: StoreApi<T, any> | undefined): CoreRuntime | null {
        if (!store) return null
        const fromRegistry = this.getGlobalRuntimeRegistry().get(store) as CoreRuntime | undefined
        if (fromRegistry) return fromRegistry
        const anyStore: any = store as any
        const fromAttached = anyStore && typeof anyStore === 'object' ? (anyStore[RUNTIME_KEY] as CoreRuntime | undefined) : undefined
        return fromAttached ?? null
    }

    getStoreSnapshot<T extends Entity>(store: StoreApi<T, any>, tag?: string): StoreSnapshot<T> {
        const handle = this.resolveStoreHandle(store, tag)
        if (!handle) return new Map<EntityId, T>()
        return handle.jotaiStore.get(handle.atom) as Map<EntityId, T>
    }

    subscribeStore<T extends Entity>(store: StoreApi<T, any>, listener: () => void, tag?: string): (() => void) {
        const handle = this.resolveStoreHandle(store, tag)
        if (!handle) return () => {}
        if (typeof (handle.jotaiStore as any).sub !== 'function') return () => {}
        return handle.jotaiStore.sub(handle.atom, () => listener())
    }

    getStoreIndexes<T extends Entity>(store: StoreApi<T, any>, tag?: string): StoreIndexes<T> | null {
        const handle = this.resolveStoreHandle(store, tag)
        return handle?.indexes ?? null
    }

    getStoreMatcher<T extends Entity>(store: StoreApi<T, any> | undefined, tag?: string): QueryMatcherOptions | undefined {
        const handle = this.resolveStoreHandle(store, tag)
        return handle?.matcher
    }

    getStoreRelations<T extends Entity>(store: StoreApi<T, any>, tag?: string): any | undefined {
        const handle = this.resolveStoreHandle(store, tag)
        return handle?.relations?.()
    }

    getStoreName<T extends Entity>(store: StoreApi<T, any>, tag?: string): string {
        const handle = this.resolveStoreHandle(store, tag)
        return String(handle?.storeName || 'store')
    }

    async hydrateStore<T extends Entity>(store: StoreApi<T, any>, items: T[], tag?: string): Promise<void> {
        if (!items.length) return
        const handle = this.resolveStoreHandle(store, tag)
        if (!handle) return
        const runtime = this.getStoreRuntime(store)
        const processed = runtime
            ? (await Promise.all(items.map(async (item) => runtime.dataProcessor.writeback(handle, item))))
                .filter((item): item is T => item !== undefined)
            : items

        if (!processed.length) return

        const before = handle.jotaiStore.get(handle.atom) as Map<T['id'], T>
        const after = new Map(before)
        const changedIds = new Set<T['id']>()

        processed.forEach(item => {
            const prev = before.get(item.id)
            after.set(item.id, item)
            if (prev !== item) changedIds.add(item.id)
        })

        if (!changedIds.size) return

        handle.jotaiStore.set(handle.atom, after)
        handle.indexes?.applyChangedIds(before, after, changedIds)
    }

    private registerStoreHandle<T extends Entity, Relations>(store: StoreApi<T, Relations>, handle: StoreHandle<T>): void {
        this.getGlobalRegistry().set(store, handle)
    }

    private registerStoreRuntime<T extends Entity, Relations>(store: StoreApi<T, Relations>, runtime: CoreRuntime): void {
        this.getGlobalRuntimeRegistry().set(store, runtime)
    }

    private resolveStoreHandle<T extends Entity>(store: StoreApi<T, any> | undefined, tag?: string): StoreHandle<T> | null {
        if (!store) {
            if (tag) throw this.buildMissingHandleError(tag)
            return null
        }
        const fromRegistry = this.getGlobalRegistry().get(store) as StoreHandle<T> | undefined
        if (fromRegistry) return fromRegistry
        const anyStore: any = store as any
        const fromAttached = anyStore && typeof anyStore === 'object' ? (anyStore[HANDLE_KEY] as StoreHandle<T> | undefined) : undefined
        if (!fromAttached && tag) {
            throw this.buildMissingHandleError(tag)
        }
        return fromAttached ?? null
    }

    private buildMissingHandleError(tag: string) {
        return new Error(`[Atoma] ${tag}: 未找到 storeHandle（atom/jotaiStore），请确认 store 已通过 createStore 创建`)
    }

    private getGlobalRegistry(): WeakMap<object, StoreHandle<any>> {
        const anyGlobal = globalThis as any
        const existing = anyGlobal[REGISTRY_KEY] as WeakMap<object, StoreHandle<any>> | undefined
        if (existing) return existing
        const next = new WeakMap<object, StoreHandle<any>>()
        anyGlobal[REGISTRY_KEY] = next
        return next
    }

    private getGlobalRuntimeRegistry(): WeakMap<object, CoreRuntime> {
        const anyGlobal = globalThis as any
        const existing = anyGlobal[RUNTIME_REGISTRY_KEY] as WeakMap<object, CoreRuntime> | undefined
        if (existing) return existing
        const next = new WeakMap<object, CoreRuntime>()
        anyGlobal[RUNTIME_REGISTRY_KEY] = next
        return next
    }

    private buildQueryMatcherOptions<T>(indexes?: Array<IndexDefinition<T>>): QueryMatcherOptions | undefined {
        const defs = indexes || []
        if (!defs.length) return undefined

        const fields: QueryMatcherOptions['fields'] = {}
        defs.forEach(def => {
            if (def.type !== 'text') return
            fields[def.field] = {
                match: {
                    minTokenLength: def.options?.minTokenLength,
                    tokenizer: def.options?.tokenizer
                },
                fuzzy: {
                    distance: def.options?.fuzzyDistance,
                    minTokenLength: def.options?.minTokenLength,
                    tokenizer: def.options?.tokenizer
                }
            }
        })

        return Object.keys(fields).length ? { fields } : undefined
    }
}

export const storeHandleManager = new StoreHandleManager()
