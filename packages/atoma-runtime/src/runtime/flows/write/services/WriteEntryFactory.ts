import { produce, type Draft } from 'immer'
import type {
    Entity,
    OperationContext,
    PartialWithId,
    StoreOperationOptions,
    UpsertWriteOptions,
} from 'atoma-types/core'
import type {
    RuntimeWriteItemMeta,
    RuntimeWriteOptions,
} from 'atoma-types/runtime'
import type { EntityId } from 'atoma-types/shared'
import type { Runtime, StoreHandle } from 'atoma-types/runtime'
import { createIdempotencyKey, ensureWriteItemMeta, requireBaseVersion, resolvePositiveVersion } from 'atoma-shared'
import type { WritePlanEntry } from '../types'
import {
    prepareCreateInput,
    prepareUpdateInput,
    resolveWriteBase,
    runBeforeSave
} from '../utils/prepareWriteInput'

function buildUpsertWriteOptions(options?: UpsertWriteOptions): RuntimeWriteOptions | undefined {
    if (!options) return undefined

    const out: RuntimeWriteOptions = {}
    if (typeof options.merge === 'boolean') out.merge = options.merge
    if (options.mode === 'strict' || options.mode === 'loose') {
        out.upsert = { mode: options.mode }
    }

    return Object.keys(out).length ? out : undefined
}

export class WriteEntryFactory {
    private readonly runtime: Runtime

    constructor(runtime: Runtime) {
        this.runtime = runtime
    }

    prepareAddEntry = async <T extends Entity>(args: {
        handle: StoreHandle<T>
        item: Partial<T>
        opContext: OperationContext
    }): Promise<{ planEntry: WritePlanEntry<T>; output: T }> => {
        const prepared = await prepareCreateInput(this.runtime, args.handle, args.item, args.opContext)
        const outbound = await this.toOutboundValue(args.handle, prepared as T, args.opContext)

        return {
            planEntry: {
                entry: {
                    entryId: this.runtime.nextOpId(args.handle.storeName, 'w'),
                    action: 'create',
                    item: {
                        entityId: prepared.id,
                        value: outbound,
                        meta: this.createWriteItemMeta()
                    }
                },
                optimistic: {
                    entityId: prepared.id,
                    value: prepared as T
                }
            },
            output: prepared as T
        }
    }

    prepareUpdateEntry = async <T extends Entity>(args: {
        handle: StoreHandle<T>
        id: EntityId
        recipe: (draft: Draft<T>) => void
        opContext: OperationContext
        options?: StoreOperationOptions
    }): Promise<{ planEntry: WritePlanEntry<T>; output: T; base: PartialWithId<T> }> => {
        const base = await resolveWriteBase(this.runtime, args.handle, args.id, args.options)
        const next = produce(base as T, draft => args.recipe(draft)) as PartialWithId<T>
        const patched = { ...next, id: args.id } as PartialWithId<T>
        const prepared = await prepareUpdateInput(this.runtime, args.handle, base, patched, args.opContext)
        const outbound = await this.toOutboundValue(args.handle, prepared as T, args.opContext)
        const baseVersion = requireBaseVersion(args.id, base)

        return {
            planEntry: {
                entry: {
                    entryId: this.runtime.nextOpId(args.handle.storeName, 'w'),
                    action: 'update',
                    item: {
                        entityId: args.id,
                        baseVersion,
                        value: outbound,
                        meta: this.createWriteItemMeta()
                    }
                },
                optimistic: {
                    entityId: args.id,
                    value: prepared as T
                }
            },
            output: prepared as T,
            base
        }
    }

    prepareUpsertEntry = async <T extends Entity>(args: {
        handle: StoreHandle<T>
        item: PartialWithId<T>
        opContext: OperationContext
        options?: StoreOperationOptions & UpsertWriteOptions
    }): Promise<{ planEntry: WritePlanEntry<T>; output: T; afterSaveAction: 'add' | 'update'; base?: PartialWithId<T> }> => {
        const id = args.item.id
        const base = args.handle.state.getSnapshot().get(id) as PartialWithId<T> | undefined
        const merge = args.options?.merge !== false

        const prepared = await (async () => {
            if (!base) {
                return await prepareCreateInput(this.runtime, args.handle, args.item as Partial<T>, args.opContext)
            }

            if (merge) {
                return await prepareUpdateInput(this.runtime, args.handle, base, args.item, args.opContext)
            }

            const now = this.runtime.now()
            const candidate = ({
                ...(args.item as Record<string, unknown>),
                id,
                createdAt: (base as Record<string, unknown>).createdAt ?? now,
                updatedAt: now,
                version: (args.item as Record<string, unknown>).version ?? (base as Record<string, unknown>).version,
                _etag: (args.item as Record<string, unknown>)._etag ?? (base as Record<string, unknown>)._etag
            } as unknown) as PartialWithId<T>

            const next = await runBeforeSave(args.handle.config.hooks, candidate, 'update')
            const processed = await this.runtime.transform.inbound(args.handle, next as T, args.opContext)
            if (!processed) {
                throw new Error('[Atoma] upsertOne: transform returned empty')
            }
            return processed as PartialWithId<T>
        })()

        const outbound = await this.toOutboundValue(args.handle, prepared as T, args.opContext)
        const baseVersion = resolvePositiveVersion(prepared)
        const writeOptions = buildUpsertWriteOptions(args.options)

        return {
            planEntry: {
                entry: {
                    entryId: this.runtime.nextOpId(args.handle.storeName, 'w'),
                    action: 'upsert',
                    item: {
                        entityId: id,
                        ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
                        value: outbound,
                        meta: this.createWriteItemMeta()
                    },
                    ...(writeOptions ? { options: writeOptions } : {})
                },
                optimistic: {
                    entityId: id,
                    value: prepared as T
                }
            },
            output: prepared as T,
            afterSaveAction: base ? 'update' : 'add',
            base
        }
    }

    prepareDeleteEntry = async <T extends Entity>(args: {
        handle: StoreHandle<T>
        id: EntityId
        opContext: OperationContext
        options?: StoreOperationOptions
    }): Promise<{ planEntry: WritePlanEntry<T>; base: PartialWithId<T> }> => {
        const base = await resolveWriteBase(this.runtime, args.handle, args.id, args.options)
        const baseVersion = requireBaseVersion(args.id, base)

        if (args.options?.force) {
            return {
                planEntry: {
                    entry: {
                        entryId: this.runtime.nextOpId(args.handle.storeName, 'w'),
                        action: 'delete',
                        item: {
                            entityId: args.id,
                            baseVersion,
                            meta: this.createWriteItemMeta()
                        }
                    },
                    optimistic: {
                        entityId: args.id
                    }
                },
                base
            }
        }

        const optimisticValue = {
            ...base,
            deleted: true,
            deletedAt: this.runtime.now()
        } as unknown as T
        const outbound = await this.toOutboundValue(args.handle, optimisticValue, args.opContext)

        return {
            planEntry: {
                entry: {
                    entryId: this.runtime.nextOpId(args.handle.storeName, 'w'),
                    action: 'update',
                    item: {
                        entityId: args.id,
                        baseVersion,
                        value: outbound,
                        meta: this.createWriteItemMeta()
                    }
                },
                optimistic: {
                    entityId: args.id,
                    value: optimisticValue
                }
            },
            base
        }
    }

    private createWriteItemMeta = (): RuntimeWriteItemMeta => {
        const now = this.runtime.now
        return ensureWriteItemMeta({
            meta: {
                idempotencyKey: createIdempotencyKey({ now }),
                clientTimeMs: now()
            },
            now
        })
    }

    private toOutboundValue = async <T extends Entity>(
        handle: StoreHandle<T>,
        value: T,
        opContext: OperationContext
    ): Promise<T> => {
        const outbound = await this.runtime.transform.outbound(handle, value, opContext)
        if (outbound === undefined) {
            throw new Error('[Atoma] transform returned empty for outbound write')
        }
        return outbound as T
    }
}
