import type { Runtime } from 'atoma-runtime'
import type { ClientPlugin } from 'atoma-types/client/plugins'
import type { SnapshotQuery, Source, StreamEvent } from 'atoma-types/devtools'
import { HUB_TOKEN } from 'atoma-types/devtools'
import { createDebugHub } from '../debug/debugHub'

type RuntimeStoreLike = {
    name?: unknown
}

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

function listStoreNames(runtime: Runtime): string[] {
    const names: string[] = []
    for (const store of runtime.stores.list()) {
        const name = String((store as RuntimeStoreLike).name ?? '').trim()
        if (!name) continue
        names.push(name)
    }
    return names.sort((left, right) => left.localeCompare(right))
}

function resolveLimit(query?: SnapshotQuery): number {
    const raw = typeof query?.limit === 'number' ? Math.floor(query.limit) : 100
    if (raw < 1) return 1
    if (raw > 1000) return 1000
    return raw
}

function resolveStoreNames({
    runtime,
    query
}: {
    runtime: Runtime
    query?: SnapshotQuery
}): string[] {
    const storeName = typeof query?.storeName === 'string'
        ? query.storeName.trim()
        : ''
    if (storeName) return [storeName]
    return listStoreNames(runtime)
}

function snapshotStores({
    runtime,
    query
}: {
    runtime: Runtime
    query?: SnapshotQuery
}): unknown[] {
    const limit = resolveLimit(query)
    const snapshots: unknown[] = []
    for (const storeName of resolveStoreNames({ runtime, query })) {
        const snapshot = runtime.debug.snapshotStore(storeName)
        if (!snapshot) continue
        snapshots.push(snapshot)
        if (snapshots.length >= limit) break
    }
    return snapshots
}

function snapshotIndexes({
    runtime,
    query
}: {
    runtime: Runtime
    query?: SnapshotQuery
}): unknown[] {
    const limit = resolveLimit(query)
    const snapshots: unknown[] = []
    for (const storeName of resolveStoreNames({ runtime, query })) {
        const snapshot = runtime.debug.snapshotIndexes(storeName)
        if (!snapshot) continue
        snapshots.push(snapshot)
        if (snapshots.length >= limit) break
    }
    return snapshots
}

function createSourceRuntime({
    runtime,
    clientId,
    sourceId,
    namespace,
    title,
    panelId,
    order,
    snapshot
}: {
    runtime: Runtime
    clientId: string
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
            clientId,
            panelId,
            type: 'data:changed',
            revision,
            timestamp: runtime.now()
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
            clientId,
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
                clientId,
                panelId,
                revision,
                timestamp: runtime.now(),
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

export function createBuiltinDebugPlugin({
    runtime
}: {
    runtime: Runtime
}): ClientPlugin {
    const storeSourceId = `runtime.store.${runtime.id}`
    const indexSourceId = `runtime.index.${runtime.id}`

    return {
        id: 'builtin.debug',
        provides: [HUB_TOKEN],
        setup: (ctx) => {
            const hub = createDebugHub()
            const unregisterHub = ctx.services.register(HUB_TOKEN, hub)

            const storeRuntime = createSourceRuntime({
                runtime,
                clientId: runtime.id,
                sourceId: storeSourceId,
                namespace: 'runtime.store',
                title: 'Store',
                panelId: 'store',
                order: 10,
                snapshot: (query) => {
                    return {
                        items: snapshotStores({ runtime, query })
                    }
                }
            })

            const indexRuntime = createSourceRuntime({
                runtime,
                clientId: runtime.id,
                sourceId: indexSourceId,
                namespace: 'runtime.index',
                title: 'Index',
                panelId: 'index',
                order: 20,
                snapshot: (query) => {
                    return {
                        items: snapshotIndexes({ runtime, query })
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

            return {
                dispose: () => {
                    safeDispose(stopEvents)
                    safeDispose(unregisterIndexSource)
                    safeDispose(unregisterStoreSource)
                    safeDispose(unregisterHub)
                }
            }
        }
    }
}
