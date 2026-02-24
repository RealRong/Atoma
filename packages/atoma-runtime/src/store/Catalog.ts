import type {
    Entity,
    Query,
    QueryResult,
    Store,
    StoreChange,
    StoreOperationOptions,
    StoreToken
} from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import type { Runtime, Schema, StoresConfig, StoreHandle, StoreCatalog, StoreSession } from 'atoma-types/runtime'
import { Factory } from './Factory'
import { ChangeFlow } from '../runtime/flows/ChangeFlow'

type CatalogEntry = Readonly<{
    handle: StoreHandle<Entity>
    api: Store<Entity>
    session: StoreSession<Entity>
}>

export class Catalog implements StoreCatalog {
    private readonly entries = new Map<string, CatalogEntry>()
    private readonly factory: Factory
    private readonly change: ChangeFlow
    private readonly runtime: Runtime
    private readonly deps: StoresConfig<Record<string, Entity>, object>

    constructor(
        runtime: Runtime,
        deps: StoresConfig<Record<string, Entity>, object> = {}
    ) {
        this.runtime = runtime
        this.deps = deps
        this.change = new ChangeFlow(this.runtime)
        this.factory = new Factory({
            runtime: this.runtime,
            schema: (this.deps.schema as Schema | undefined) ?? {},
            createId: this.deps.createId,
            processor: this.deps.processor
        })
    }

    private ensureEntry = (name: StoreToken): CatalogEntry => {
        const existing = this.entries.get(name)
        if (existing) return existing

        const built = this.factory.build(name)
        const handle = built.handle as StoreHandle<Entity>
        const api = built.api as Store<Entity>
        const createContext = (options?: StoreOperationOptions) => {
            return options?.context
                ? this.runtime.engine.action.createContext(options.context)
                : undefined
        }
        const reconcile = async (
            mode: 'upsert' | 'replace',
            items: ReadonlyArray<unknown>,
            options?: StoreOperationOptions
        ) => {
            const context = createContext(options)
            const results = await Promise.all(items.map(async (item): Promise<Entity | undefined> => {
                if (!item || typeof item !== 'object') return undefined
                return await this.runtime.processor.writeback(handle, item as Entity, context)
            }))
            const normalized = results.filter((item): item is Entity => item !== undefined)
            const changes = mode === 'replace'
                ? handle.state.replace(normalized)
                : handle.state.upsert(normalized)
            return {
                changes,
                items: normalized,
                results
            } as const
        }
        const remove = (ids: ReadonlyArray<EntityId>) => {
            const queryIds = ids.length > 1
                ? Array.from(new Set(ids))
                : [...ids]
            if (!queryIds.length) {
                return {
                    changes: [],
                    items: [],
                    results: []
                } as const
            }
            const snapshot = handle.state.snapshot() as ReadonlyMap<EntityId, Entity>
            const deletes: StoreChange<Entity>[] = []
            queryIds.forEach((id) => {
                const before = snapshot.get(id)
                if (before !== undefined) {
                    deletes.push({
                        id,
                        before
                    })
                }
            })
            const changes = deletes.length
                ? handle.state.apply(deletes)
                : []
            return {
                changes,
                items: [],
                results: []
            } as const
        }
        const session: StoreSession<Entity> = {
            name,
            query: (query: Query<Entity>) => {
                return this.runtime.engine.query.evaluate({
                    state: handle.state,
                    query
                }) as QueryResult<Entity>
            },
            apply: async (
                changes: ReadonlyArray<StoreChange<Entity>>,
                options?: StoreOperationOptions
            ) => {
                await this.change.apply(handle, changes, options)
            },
            revert: async (
                changes: ReadonlyArray<StoreChange<Entity>>,
                options?: StoreOperationOptions
            ) => {
                await this.change.revert(handle, changes, options)
            },
            reconcile: async (input, options?: StoreOperationOptions) => {
                if (input.mode === 'remove') {
                    return remove(Array.isArray(input.ids) ? input.ids : [])
                }
                return await reconcile(
                    input.mode,
                    Array.isArray(input.items) ? input.items : [],
                    options
                )
            },
            hydrate: async (
                ids: ReadonlyArray<EntityId>,
                options?: StoreOperationOptions & Readonly<{ mode?: 'refresh' | 'missing' }>
            ) => {
                const queryIds = ids.length > 1
                    ? Array.from(new Set(ids))
                    : [...ids]
                if (!queryIds.length) return new Map<EntityId, Entity>()

                const mode = options?.mode ?? 'refresh'
                const snapshot = handle.state.snapshot() as ReadonlyMap<EntityId, Entity>
                const fetchIds = mode === 'missing'
                    ? queryIds.filter((id) => !snapshot.has(id))
                    : queryIds

                if (fetchIds.length && this.runtime.execution.hasExecutor('query')) {
                    const output = await this.runtime.execution.query(
                        {
                            handle,
                            query: {
                                filter: {
                                    op: 'in',
                                    field: 'id',
                                    values: fetchIds
                                }
                            } as Query<Entity>
                        },
                        options?.signal ? { signal: options.signal } : undefined
                    )
                    await reconcile(
                        'upsert',
                        Array.isArray(output.data) ? output.data : [],
                        options
                    )
                }

                const resolved = new Map<EntityId, Entity>()
                const next = handle.state.snapshot() as ReadonlyMap<EntityId, Entity>
                queryIds.forEach((id) => {
                    const item = next.get(id)
                    if (item !== undefined) {
                        resolved.set(id, item)
                    }
                })
                return resolved
            }
        }

        const entry: CatalogEntry = {
            handle,
            api,
            session
        }

        this.runtime.events.emit('storeCreated', {
            storeName: name
        })

        this.entries.set(name, entry)

        return entry
    }

    ensure = <T extends Entity = Entity>(name: StoreToken): Store<T> => {
        return this.ensureEntry(name).api as unknown as Store<T>
    }

    use = <T extends Entity = Entity>(name: StoreToken): StoreSession<T> => {
        return this.ensureEntry(name).session as unknown as StoreSession<T>
    }

    inspect = <T extends Entity = Entity>(name: StoreToken): Readonly<{
        snapshot: ReadonlyMap<EntityId, T>
        indexes: StoreHandle<T>['state']['indexes']
    }> => {
        const entry = this.ensureEntry(name)
        const handle = entry.handle
        return {
            snapshot: handle.state.snapshot() as ReadonlyMap<EntityId, T>,
            indexes: handle.state.indexes
        }
    }

    list = (): StoreToken[] => {
        return Array.from(this.entries.keys()) as StoreToken[]
    }
}
