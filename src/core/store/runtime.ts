import type { PrimitiveAtom } from 'jotai/vanilla'
import { globalStore } from '../BaseStore'
import { createStoreContext } from '../StoreContext'
import type { StoreContext } from '../StoreContext'
import type { DevtoolsBridge } from '../../devtools/types'
import { getGlobalDevtools, registerGlobalIndex } from '../../devtools/global'
import { StoreIndexes } from '../indexes/StoreIndexes'
import type { IndexDefinition, IAdapter, JotaiStore, StoreConfig, StoreKey, StoreOperationOptions, StoreReadOptions, Entity } from '../types'
import type { QueryMatcherOptions } from '../query/QueryMatcher'
import { Observability } from '../../observability'
import type { ObservabilityContext, ObservabilityRuntime } from '../../observability'
import type { DebugEvent } from '../../observability/types'

export type StoreRuntime<T extends Entity> = {
    atom: PrimitiveAtom<Map<StoreKey, T>>
    adapter: IAdapter<T>
    jotaiStore: JotaiStore
    context: StoreContext
    storeName: string
    observability: ObservabilityRuntime
    indexes: StoreIndexes<T> | null
    matcher?: QueryMatcherOptions
    hooks: StoreConfig<T>['hooks']
    schema: StoreConfig<T>['schema']
    idGenerator: StoreConfig<T>['idGenerator']
    transform: (item: T) => T
    stopIndexDevtools?: () => void
}

export function createStoreRuntime<T extends Entity>(params: {
    atom: PrimitiveAtom<Map<StoreKey, T>>
    adapter: IAdapter<T>
    config?: StoreConfig<T>
}): StoreRuntime<T> {
    const { atom, adapter, config } = params

    const jotaiStore = config?.store || globalStore
    const context = config?.context || createStoreContext()
    if (config?.storeName && !context.storeName) {
        context.storeName = config.storeName
    }
    if (config?.debug && !context.debug) {
        context.debug = config.debug as any
    }
    if (config?.debug?.enabled && !context.debugSink) {
        const sink: ((e: DebugEvent) => void) = (e) => {
            const bridge = config?.devtools ?? getGlobalDevtools()
            try {
                bridge?.emit({ type: 'debug-event', payload: e as any })
            } catch {
                // ignore
            }
        }
        context.debugSink = sink
    }

    const storeName = context.storeName || config?.storeName || adapter.name || 'store'

    const indexes = config?.indexes && config.indexes.length ? new StoreIndexes<T>(config.indexes) : null

    const matcher = buildQueryMatcherOptions(config?.indexes)
    const stopIndexDevtools = registerStoreIndexesSnapshot({
        indexes,
        devtools: config?.devtools,
        storeName
    })

    const transform = (item: T): T => {
        return config?.transformData ? config.transformData(item) : item
    }

    const observability = Observability.runtime.create({
        scope: storeName,
        debug: context.debug,
        onEvent: context.debugSink
    })

    return {
        atom,
        adapter,
        jotaiStore,
        context,
        storeName,
        observability,
        indexes,
        matcher,
        hooks: config?.hooks,
        schema: config?.schema,
        idGenerator: config?.idGenerator,
        transform,
        stopIndexDevtools
    }
}

export function resolveObservabilityContext<T extends Entity>(
    runtime: StoreRuntime<T>,
    options?: StoreOperationOptions | StoreReadOptions | { traceId?: string; explain?: boolean }
): ObservabilityContext {
    const anyOptions = options as any
    return runtime.observability.createContext({
        traceId: typeof anyOptions?.traceId === 'string' && anyOptions.traceId ? anyOptions.traceId : undefined,
        explain: anyOptions?.explain === true
    })
}

export function buildQueryMatcherOptions<T>(indexes?: Array<IndexDefinition<T>>): QueryMatcherOptions | undefined {
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

export function registerStoreIndexesSnapshot<T>(params: {
    indexes: StoreIndexes<T> | null
    devtools?: DevtoolsBridge
    storeName?: string
}) {
    const { indexes, devtools, storeName } = params
    if (!indexes) return undefined

    const name = storeName || 'store'
    const snapshot = () => {
        const list = indexes.getIndexSnapshots().map(s => ({
            field: s.field,
            type: s.type,
            dirty: s.dirty,
            size: s.totalDocs,
            distinctValues: s.distinctValues,
            avgSetSize: s.avgSetSize,
            maxSetSize: s.maxSetSize,
            minSetSize: s.minSetSize
        }))

        return { name, indexes: list, lastQuery: indexes.getLastQueryPlan() }
    }

    return devtools?.registerIndexManager?.({ name, snapshot }) || registerGlobalIndex({ name, snapshot })
}
