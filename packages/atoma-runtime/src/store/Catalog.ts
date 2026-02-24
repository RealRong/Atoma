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

const EMPTY_ENTITY_CHANGES: ReadonlyArray<StoreChange<Entity>> = []
const EMPTY_ENTITIES: ReadonlyArray<Entity> = []
const EMPTY_RESULTS: ReadonlyArray<Entity | undefined> = []
const RECONCILE_WRITEBACK_CONCURRENCY = 32

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

    private createSession = ({
        name,
        handle
    }: {
        name: StoreToken
        handle: StoreHandle<Entity>
    }): StoreSession<Entity> => {
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
            if (!items.length) {
                return {
                    changes: mode === 'replace'
                        ? handle.state.replace(EMPTY_ENTITIES)
                        : EMPTY_ENTITY_CHANGES,
                    items: EMPTY_ENTITIES,
                    results: EMPTY_RESULTS
                } as const
            }

            const context = createContext(options)
            const results: Array<Entity | undefined> = new Array(items.length)
            let cursor = 0
            const consume = async () => {
                while (true) {
                    const index = cursor
                    cursor += 1
                    if (index >= items.length) return
                    const item = items[index]
                    if (!item || typeof item !== 'object') {
                        results[index] = undefined
                        continue
                    }
                    results[index] = await this.runtime.processor.writeback(handle, item as Entity, context)
                }
            }

            const workers: Array<Promise<void>> = []
            const workerCount = Math.min(RECONCILE_WRITEBACK_CONCURRENCY, items.length)
            for (let index = 0; index < workerCount; index += 1) {
                workers.push(consume())
            }
            await Promise.all(workers)

            const normalized = results.filter((item): item is Entity => item !== undefined)
            const changes = mode === 'replace'
                ? handle.state.replace(normalized)
                : handle.state.upsert(normalized)
            const snapshot = handle.state.snapshot() as ReadonlyMap<EntityId, Entity>
            return {
                changes,
                items: normalized.map((item) => snapshot.get(item.id) ?? item),
                results
            } as const
        }
        const remove = (ids: ReadonlyArray<EntityId>) => {
            const snapshot = handle.state.snapshot() as ReadonlyMap<EntityId, Entity>
            const changes = (ids.length > 1 ? Array.from(new Set(ids)) : ids)
                .map((id): StoreChange<Entity> | undefined => {
                    const before = snapshot.get(id)
                    return before === undefined
                        ? undefined
                        : { id, before }
                })
                .filter((change): change is StoreChange<Entity> => change !== undefined)
            return changes.length
                ? handle.state.apply(changes)
                : EMPTY_ENTITY_CHANGES
        }
        return {
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
                    return {
                        changes: remove(Array.isArray(input.ids) ? input.ids : []),
                        items: EMPTY_ENTITIES,
                        results: EMPTY_RESULTS
                    } as const
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
                    : ids
                if (!queryIds.length) return new Map<EntityId, Entity>()

                const mode = options?.mode ?? 'refresh'
                if (queryIds.length === 1) {
                    const id = queryIds[0]
                    const snapshot = handle.state.snapshot() as ReadonlyMap<EntityId, Entity>
                    if (!(mode === 'missing' && snapshot.has(id)) && this.runtime.execution.hasExecutor('query')) {
                        const output = await this.runtime.execution.query(
                            {
                                handle,
                                query: {
                                    filter: {
                                        op: 'in',
                                        field: 'id',
                                        values: [id]
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
                    const next = (handle.state.snapshot() as ReadonlyMap<EntityId, Entity>).get(id)
                    return next === undefined
                        ? new Map<EntityId, Entity>()
                        : new Map<EntityId, Entity>([[id, next]])
                }

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
    }

    private ensureEntry = (name: StoreToken): CatalogEntry => {
        const existing = this.entries.get(name)
        if (existing) return existing

        const built = this.factory.build(name)
        const handle = built.handle as StoreHandle<Entity>
        const api = built.api as Store<Entity>
        const session = this.createSession({ name, handle })

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
