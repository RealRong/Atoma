import type { PluginContext } from 'atoma-types/client/plugins'
import type { Hub, SnapshotQuery, Source, StreamEvent } from 'atoma-types/devtools'

type SourceRuntime = {
    source: Source
    markChanged: () => void
}

function safeDispose(dispose?: () => void): void {
    if (typeof dispose !== 'function') return
    try {
        dispose()
    } catch {
        // ignore
    }
}

function listStoreNames(ctx: PluginContext): string[] {
    return ctx.runtime.stores
        .list()
        .map(name => String(name))
        .sort((left, right) => left.localeCompare(right))
}

function resolveLimit(query?: SnapshotQuery): number {
    const raw = typeof query?.limit === 'number' ? Math.floor(query.limit) : 100
    if (raw < 1) return 1
    if (raw > 1000) return 1000
    return raw
}

function resolveStoreNames({
    ctx,
    query
}: {
    ctx: PluginContext
    query?: SnapshotQuery
}): string[] {
    const storeName = typeof query?.storeName === 'string'
        ? query.storeName.trim()
        : ''
    if (storeName) return [storeName]
    return listStoreNames(ctx)
}

function snapshotStores({
    ctx,
    query
}: {
    ctx: PluginContext
    query?: SnapshotQuery
}): unknown[] {
    const limit = resolveLimit(query)
    const snapshots: unknown[] = []
    for (const storeName of resolveStoreNames({ ctx, query })) {
        const snapshot = ctx.runtime.debug.snapshotStore(storeName)
        if (!snapshot) continue
        snapshots.push(snapshot)
        if (snapshots.length >= limit) break
    }
    return snapshots
}

function snapshotIndexes({
    ctx,
    query
}: {
    ctx: PluginContext
    query?: SnapshotQuery
}): unknown[] {
    const limit = resolveLimit(query)
    const snapshots: unknown[] = []
    for (const storeName of resolveStoreNames({ ctx, query })) {
        const snapshot = ctx.runtime.debug.snapshotIndexes(storeName)
        if (!snapshot) continue
        snapshots.push(snapshot)
        if (snapshots.length >= limit) break
    }
    return snapshots
}

function createSourceRuntime({
    ctx,
    sourceId,
    namespace,
    title,
    panelId,
    order,
    snapshot
}: {
    ctx: PluginContext
    sourceId: string
    namespace: string
    title: string
    panelId: string
    order: number
    snapshot: (query?: SnapshotQuery) => unknown
}): SourceRuntime {
    let revision = 0
    const subscribers = new Set<(event: StreamEvent) => void>()

    const emitChanged = () => {
        revision += 1
        const event: StreamEvent = {
            version: 1,
            sourceId,
            clientId: ctx.clientId,
            panelId,
            type: 'data:changed',
            revision,
            timestamp: ctx.runtime.now()
        }

        for (const subscriber of subscribers) {
            try {
                subscriber(event)
            } catch {
                // ignore
            }
        }
    }

    const source: Source = {
        spec: {
            id: sourceId,
            clientId: ctx.clientId,
            namespace,
            title,
            priority: order,
            panels: [
                {
                    id: panelId,
                    title,
                    order,
                    renderer: 'table'
                },
                {
                    id: 'raw',
                    title: 'Raw',
                    order: 999,
                    renderer: 'raw'
                }
            ],
            capability: {
                snapshot: true,
                stream: true,
                search: true,
                paginate: true
            },
            tags: ['builtin']
        },
        snapshot: (query?: SnapshotQuery) => {
            return {
                version: 1,
                sourceId,
                clientId: ctx.clientId,
                panelId,
                revision,
                timestamp: ctx.runtime.now(),
                data: snapshot(query),
                meta: { title }
            }
        },
        subscribe: (fn) => {
            subscribers.add(fn)
            return () => {
                subscribers.delete(fn)
            }
        }
    }

    return {
        source,
        markChanged: emitChanged
    }
}

export function registerBuiltinSources({
    ctx,
    hub
}: {
    ctx: PluginContext
    hub: Hub
}): () => void {
    const storeRuntime = createSourceRuntime({
        ctx,
        sourceId: `runtime.store.${ctx.clientId}`,
        namespace: 'runtime.store',
        title: 'Store',
        panelId: 'store',
        order: 10,
        snapshot: (query) => {
            return {
                items: snapshotStores({ ctx, query })
            }
        }
    })

    const indexRuntime = createSourceRuntime({
        ctx,
        sourceId: `runtime.index.${ctx.clientId}`,
        namespace: 'runtime.index',
        title: 'Index',
        panelId: 'index',
        order: 20,
        snapshot: (query) => {
            return {
                items: snapshotIndexes({ ctx, query })
            }
        }
    })

    const unregisterStoreSource = hub.register(storeRuntime.source)
    const unregisterIndexSource = hub.register(indexRuntime.source)

    const stopEvents = ctx.events.register({
        store: {
            onCreated: () => {
                storeRuntime.markChanged()
                indexRuntime.markChanged()
            }
        },
        write: {
            onCommitted: () => {
                storeRuntime.markChanged()
                indexRuntime.markChanged()
            }
        }
    })

    return () => {
        safeDispose(stopEvents)
        safeDispose(unregisterIndexSource)
        safeDispose(unregisterStoreSource)
    }
}
