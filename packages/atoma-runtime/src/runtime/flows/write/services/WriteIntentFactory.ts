import { produce, type Draft } from 'immer'
import type {
    Entity,
    OperationContext,
    PartialWithId,
    StoreOperationOptions,
    UpsertWriteOptions,
    WriteIntent,
    WriteIntentOptions
} from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import type { CoreRuntime, StoreHandle } from 'atoma-types/runtime'
import { requireBaseVersion, resolvePositiveVersion } from 'atoma-shared'
import {
    prepareCreateInput,
    prepareUpdateInput,
    resolveWriteBase,
    runBeforeSave
} from '../utils/prepareWriteInput'

function buildUpsertIntentOptions(options?: UpsertWriteOptions): WriteIntentOptions | undefined {
    if (!options) return undefined

    const out: WriteIntentOptions = {}
    if (typeof options.merge === 'boolean') out.merge = options.merge
    if (options.mode === 'strict' || options.mode === 'loose') {
        out.upsert = { mode: options.mode }
    }

    return Object.keys(out).length ? out : undefined
}

export class WriteIntentFactory {
    private readonly runtime: CoreRuntime

    constructor(runtime: CoreRuntime) {
        this.runtime = runtime
    }

    prepareAddIntent = async <T extends Entity>(args: {
        handle: StoreHandle<T>
        item: Partial<T>
        opContext: OperationContext
    }): Promise<{ intent: WriteIntent<T>; output: T }> => {
        const prepared = await prepareCreateInput(this.runtime, args.handle, args.item, args.opContext)
        return {
            intent: {
                action: 'create',
                entityId: prepared.id,
                value: prepared as T,
                intent: 'created'
            },
            output: prepared as T
        }
    }

    prepareUpdateIntent = async <T extends Entity>(args: {
        handle: StoreHandle<T>
        id: EntityId
        recipe: (draft: Draft<T>) => void
        opContext: OperationContext
        options?: StoreOperationOptions
    }): Promise<{ intent: WriteIntent<T>; output: T; base: PartialWithId<T> }> => {
        const base = await resolveWriteBase(this.runtime, args.handle, args.id, args.options)
        const next = produce(base as T, draft => args.recipe(draft)) as PartialWithId<T>
        const patched = { ...next, id: args.id } as PartialWithId<T>
        const prepared = await prepareUpdateInput(this.runtime, args.handle, base, patched, args.opContext)
        const baseVersion = requireBaseVersion(args.id, base)

        return {
            intent: {
                action: 'update',
                entityId: args.id,
                baseVersion,
                value: prepared as T
            },
            output: prepared as T,
            base
        }
    }

    prepareUpsertIntent = async <T extends Entity>(args: {
        handle: StoreHandle<T>
        item: PartialWithId<T>
        opContext: OperationContext
        options?: StoreOperationOptions & UpsertWriteOptions
    }): Promise<{ intent: WriteIntent<T>; output: T; afterSaveAction: 'add' | 'update'; base?: PartialWithId<T> }> => {
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

        const baseVersion = resolvePositiveVersion(prepared)
        const intentOptions = buildUpsertIntentOptions(args.options)

        return {
            intent: {
                action: 'upsert',
                entityId: id,
                ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
                value: prepared as T,
                ...(intentOptions ? { options: intentOptions } : {})
            },
            output: prepared as T,
            afterSaveAction: base ? 'update' : 'add',
            base
        }
    }

    prepareDeleteIntent = async <T extends Entity>(args: {
        handle: StoreHandle<T>
        id: EntityId
        options?: StoreOperationOptions
    }): Promise<{ intent: WriteIntent<T>; base: PartialWithId<T> }> => {
        const base = await resolveWriteBase(this.runtime, args.handle, args.id, args.options)
        const baseVersion = requireBaseVersion(args.id, base)

        if (args.options?.force) {
            return {
                intent: {
                    action: 'delete',
                    entityId: args.id,
                    baseVersion
                },
                base
            }
        }

        return {
            intent: {
                action: 'update',
                entityId: args.id,
                baseVersion,
                value: {
                    ...base,
                    deleted: true,
                    deletedAt: this.runtime.now()
                } as unknown as T
            },
            base
        }
    }
}
