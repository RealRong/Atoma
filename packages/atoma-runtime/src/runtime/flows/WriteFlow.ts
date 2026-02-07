import { produce, type Draft, type Patch } from 'immer'
import type { Draft as ImmerDraft } from 'immer'
import type {
    Entity,
    OperationContext,
    PartialWithId,
    StoreOperationOptions,
    UpsertWriteOptions,
    WriteIntent,
    WriteIntentOptions,
    WriteManyResult
} from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import type { CoreRuntime, RuntimeWrite, RuntimeWriteHookSource, StoreHandle } from 'atoma-types/runtime'
import { version } from 'atoma-shared'
import { buildWriteIntentsFromPatches } from '../persistence'
import { ensureActionId, prepareForAdd, prepareForUpdate, resolveBaseForWrite, runAfterSave, runBeforeSave } from './write/prepare'
import { WriteCommandService } from './write/WriteCommandService'
import { WriteBatchRunner } from './write/WriteBatchRunner'

function buildUpsertIntentOptions(options?: UpsertWriteOptions): WriteIntentOptions | undefined {
    if (!options) return undefined
    const out: WriteIntentOptions = {}
    if (typeof options.merge === 'boolean') out.merge = options.merge
    if (options.mode === 'strict' || options.mode === 'loose') out.upsert = { mode: options.mode }
    return Object.keys(out).length ? out : undefined
}

function buildRootPatches<T>(args: {
    id: EntityId
    before?: T
    after?: T
    remove?: boolean
}): { patches: Patch[]; inversePatches: Patch[] } {
    const id = args.id
    const before = args.before
    const after = args.after
    const hasBefore = before !== undefined
    const hasAfter = after !== undefined

    if (args.remove) {
        const patches: Patch[] = [{ op: 'remove', path: [id] as any }]
        const inversePatches: Patch[] = hasBefore
            ? [{ op: 'add', path: [id] as any, value: before } as any]
            : []
        return { patches, inversePatches }
    }

    if (!hasAfter) {
        return { patches: [], inversePatches: [] }
    }

    if (hasBefore) {
        return {
            patches: [{ op: 'replace', path: [id] as any, value: after } as any],
            inversePatches: [{ op: 'replace', path: [id] as any, value: before } as any]
        }
    }

    return {
        patches: [{ op: 'add', path: [id] as any, value: after } as any],
        inversePatches: [{ op: 'remove', path: [id] as any }]
    }
}

async function prepareAddIntent<T extends Entity>(args: {
    runtime: CoreRuntime
    handle: StoreHandle<T>
    item: Partial<T>
    opContext: OperationContext
}): Promise<{ intent: WriteIntent<T>; output: T }> {
    const prepared = await prepareForAdd(args.runtime, args.handle, args.item, args.opContext)
    return {
        intent: {
            action: 'create',
            entityId: prepared.id as EntityId,
            value: prepared as T,
            intent: 'created'
        },
        output: prepared as T
    }
}

async function prepareUpdateIntent<T extends Entity>(args: {
    runtime: CoreRuntime
    handle: StoreHandle<T>
    id: EntityId
    recipe: (draft: Draft<T>) => void
    opContext: OperationContext
    options?: StoreOperationOptions
}): Promise<{ intent: WriteIntent<T>; output: T; base: PartialWithId<T> }> {
    const base = await resolveBaseForWrite(args.runtime, args.handle, args.id, args.options)
    const next = produce(base as any, (draft: Draft<T>) => args.recipe(draft)) as any
    const patched = { ...(next as any), id: args.id } as PartialWithId<T>
    const prepared = await prepareForUpdate(args.runtime, args.handle, base, patched, args.opContext)
    const baseVersion = version.requireBaseVersion(args.id, base as any)
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

async function prepareUpsertIntent<T extends Entity>(args: {
    runtime: CoreRuntime
    handle: StoreHandle<T>
    item: PartialWithId<T>
    opContext: OperationContext
    options?: StoreOperationOptions & UpsertWriteOptions
}): Promise<{ intent: WriteIntent<T>; output: T; afterSaveAction: 'add' | 'update'; base?: PartialWithId<T> }> {
    const id = args.item.id
    const base = args.handle.state.getSnapshot().get(id) as PartialWithId<T> | undefined
    const merge = args.options?.merge !== false

    const prepared = await (async () => {
        if (!base) {
            return await prepareForAdd(args.runtime, args.handle, args.item as any, args.opContext)
        }

        if (merge) {
            return await prepareForUpdate(args.runtime, args.handle, base, args.item, args.opContext)
        }

        const now = args.runtime.now()
        const createdAt = (base as any).createdAt ?? now
        const candidate: any = {
            ...(args.item as any),
            id,
            createdAt,
            updatedAt: now
        }

        if (candidate.version === undefined && typeof (base as any).version === 'number') {
            candidate.version = (base as any).version
        }
        if (candidate._etag === undefined && typeof (base as any)._etag === 'string') {
            candidate._etag = (base as any)._etag
        }

        const next = await runBeforeSave(args.handle.config.hooks, candidate as any, 'update')
        const processed = await args.runtime.transform.inbound(args.handle, next as any, args.opContext)
        if (!processed) {
            throw new Error('[Atoma] upsertOne: transform returned empty')
        }
        return processed as PartialWithId<T>
    })()

    const baseVersion = version.resolvePositiveVersion(prepared as any)
    const intentOptions = buildUpsertIntentOptions(args.options)
    const intent: WriteIntent<T> = {
        action: 'upsert',
        entityId: id,
        ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
        value: prepared as T,
        ...(intentOptions ? { options: intentOptions } : {})
    }
    return {
        intent,
        output: prepared as T,
        afterSaveAction: base ? 'update' : 'add',
        base
    }
}

async function prepareDeleteIntent<T extends Entity>(args: {
    runtime: CoreRuntime
    handle: StoreHandle<T>
    id: EntityId
    opContext: OperationContext
    options?: StoreOperationOptions
}): Promise<{ intent: WriteIntent<T>; base: PartialWithId<T> }> {
    const base = await resolveBaseForWrite(args.runtime, args.handle, args.id, args.options)
    const baseVersion = version.requireBaseVersion(args.id, base as any)
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
            value: Object.assign({}, base, { deleted: true, deletedAt: args.runtime.now() }) as unknown as T
        },
        base
    }
}

export class WriteFlow implements RuntimeWrite {
    private runtime: CoreRuntime
    private readonly writeCommands: WriteCommandService
    private readonly writeBatchRunner: WriteBatchRunner

    constructor(runtime: CoreRuntime) {
        this.runtime = runtime
        this.writeCommands = new WriteCommandService()
        this.writeBatchRunner = new WriteBatchRunner()
    }

    private executeSingleWrite = async <T extends Entity>(args: {
        handle: StoreHandle<T>
        opContext: OperationContext
        writeStrategy?: string
        intents: Array<WriteIntent<T>>
        source: RuntimeWriteHookSource
        output?: T
        patchPayload: { patches: Patch[]; inversePatches: Patch[] } | null
        afterSaveAction?: 'add' | 'update'
        returnValue?: T
    }): Promise<T> => {
        const { handle, opContext, intents, source, patchPayload } = args
        const hooks = this.runtime.hooks
        hooks.emit.writeStart({ handle, opContext, intents, source })

        try {
            const result = await this.executeWrite<T>({
                handle,
                opContext,
                writeStrategy: args.writeStrategy,
                intents
            })

            if (patchPayload) {
                hooks.emit.writePatches({
                    handle,
                    opContext,
                    patches: patchPayload.patches,
                    inversePatches: patchPayload.inversePatches,
                    source
                })
            }

            const finalValue = (result ?? args.returnValue ?? args.output) as T
            hooks.emit.writeCommitted({ handle, opContext, result: finalValue })

            if (args.afterSaveAction && args.output) {
                await runAfterSave(handle.config.hooks, args.output as any, args.afterSaveAction)
            }

            return finalValue
        } catch (error) {
            hooks.emit.writeFailed({ handle, opContext, error })
            throw error
        }
    }

    addOne = async <T extends Entity>(handle: StoreHandle<T>, item: Partial<T>, options?: StoreOperationOptions): Promise<T> => {
        const runtime = this.runtime
        const opContext = ensureActionId(options?.opContext)
        const { intent, output } = await prepareAddIntent({ runtime, handle, item, opContext })
        const intents = [intent]

        const patchPayload = (() => {
            if (!runtime.hooks.has.writePatches) return null
            const entityId = intent.entityId as EntityId | undefined
            if (!entityId) return null
            const before = handle.state.getSnapshot().get(entityId) as T | undefined
            return buildRootPatches<T>({
                id: entityId,
                before,
                after: output as T
            })
        })()

        return await this.executeSingleWrite({
            handle,
            opContext,
            writeStrategy: options?.writeStrategy ?? handle.config.defaultWriteStrategy,
            intents,
            source: 'addOne',
            output: output as T,
            patchPayload,
            afterSaveAction: 'add',
            returnValue: output as T
        })
    }

    addMany = async <T extends Entity>(handle: StoreHandle<T>, items: Array<Partial<T>>, options?: StoreOperationOptions): Promise<T[]> => {
        const results = await this.writeBatchRunner.runMany({
            items,
            options,
            runner: (entry) => this.addOne(handle, entry, options),
            toResult: ({ index, value }) => ({ index, ok: true as const, value }),
            toError: ({ index, error }) => ({ index, ok: false as const, error })
        })

        const firstError = results.find(item => !item.ok)
        if (firstError) {
            throw firstError.error
        }

        return results.map(item => item.value as T)
    }

    updateOne = async <T extends Entity>(handle: StoreHandle<T>, id: EntityId, recipe: (draft: ImmerDraft<T>) => void, options?: StoreOperationOptions): Promise<T> => {
        const runtime = this.runtime
        const opContext = ensureActionId(options?.opContext)
        const { intent, output, base } = await prepareUpdateIntent({
            runtime,
            handle,
            id,
            recipe: recipe as any,
            opContext,
            options
        })
        const intents = [intent]

        const patchPayload = runtime.hooks.has.writePatches
            ? buildRootPatches<T>({ id, before: base as T, after: output as T })
            : null

        return await this.executeSingleWrite({
            handle,
            opContext,
            writeStrategy: options?.writeStrategy ?? handle.config.defaultWriteStrategy,
            intents,
            source: 'updateOne',
            output: output as T,
            patchPayload,
            afterSaveAction: 'update',
            returnValue: output as T
        })
    }

    updateMany = async <T extends Entity>(handle: StoreHandle<T>, items: Array<{ id: EntityId; recipe: (draft: ImmerDraft<T>) => void }>, options?: StoreOperationOptions): Promise<WriteManyResult<T>> => {
        return await this.writeBatchRunner.runMany({
            items,
            options,
            runner: (entry) => this.updateOne(handle, entry.id, entry.recipe, options),
            toResult: ({ index, value }) => ({ index, ok: true, value }),
            toError: ({ index, error }) => ({ index, ok: false, error })
        }) as WriteManyResult<T>
    }

    upsertOne = async <T extends Entity>(handle: StoreHandle<T>, item: PartialWithId<T>, options?: StoreOperationOptions & UpsertWriteOptions): Promise<T> => {
        const runtime = this.runtime
        const opContext = ensureActionId(options?.opContext)
        const { intent, output, afterSaveAction, base } = await prepareUpsertIntent({
            runtime,
            handle,
            item,
            opContext,
            options
        })
        const intents = [intent]

        const patchPayload = (() => {
            if (!runtime.hooks.has.writePatches) return null
            const entityId = intent.entityId as EntityId | undefined
            if (!entityId) return null
            return buildRootPatches<T>({
                id: entityId,
                before: base as T | undefined,
                after: output as T
            })
        })()

        return await this.executeSingleWrite({
            handle,
            opContext,
            writeStrategy: options?.writeStrategy ?? handle.config.defaultWriteStrategy,
            intents,
            source: 'upsertOne',
            output: output as T,
            patchPayload,
            afterSaveAction,
            returnValue: output as T
        })
    }

    upsertMany = async <T extends Entity>(handle: StoreHandle<T>, items: Array<PartialWithId<T>>, options?: StoreOperationOptions & UpsertWriteOptions): Promise<WriteManyResult<T>> => {
        return await this.writeBatchRunner.runMany({
            items,
            options,
            runner: (entry) => this.upsertOne(handle, entry, options),
            toResult: ({ index, value }) => ({ index, ok: true, value }),
            toError: ({ index, error }) => ({ index, ok: false, error })
        }) as WriteManyResult<T>
    }

    deleteOne = async <T extends Entity>(handle: StoreHandle<T>, id: EntityId, options?: StoreOperationOptions): Promise<boolean> => {
        const runtime = this.runtime
        const opContext = ensureActionId(options?.opContext)
        const { intent, base } = await prepareDeleteIntent({
            runtime,
            handle,
            id,
            opContext,
            options
        })
        const intents = [intent]

        const patchPayload = runtime.hooks.has.writePatches
            ? buildRootPatches<T>({
                id,
                before: base as T,
                after: intent.value as T | undefined,
                remove: intent.action === 'delete'
            })
            : null

        await this.executeSingleWrite({
            handle,
            opContext,
            writeStrategy: options?.writeStrategy ?? handle.config.defaultWriteStrategy,
            intents,
            source: 'deleteOne',
            patchPayload,
            returnValue: true as any
        })
        return true
    }

    deleteMany = async <T extends Entity>(handle: StoreHandle<T>, ids: EntityId[], options?: StoreOperationOptions): Promise<WriteManyResult<boolean>> => {
        return await this.writeBatchRunner.runMany({
            items: ids,
            options,
            runner: (id) => this.deleteOne(handle, id, options),
            toResult: ({ index, value }) => ({ index, ok: true, value }),
            toError: ({ index, error }) => ({ index, ok: false, error })
        }) as WriteManyResult<boolean>
    }

    patches = async <T extends Entity>(handle: StoreHandle<T>, patches: Patch[], inversePatches: Patch[], options?: StoreOperationOptions): Promise<void> => {
        const opContext = ensureActionId(options?.opContext)
        const before = handle.state.getSnapshot() as Map<EntityId, T>
        const intents = buildWriteIntentsFromPatches({
            baseState: before,
            patches,
            inversePatches
        })
        const patchPayload = this.runtime.hooks.has.writePatches
            ? { patches, inversePatches }
            : null

        await this.executeSingleWrite({
            handle,
            opContext,
            writeStrategy: options?.writeStrategy ?? handle.config.defaultWriteStrategy,
            intents,
            source: 'patches',
            patchPayload,
            returnValue: undefined as any
        })
    }

    private executeWrite = async <T extends Entity>(args: {
        handle: StoreHandle<T>
        opContext: OperationContext
        writeStrategy?: string
        intents?: Array<WriteIntent<T>>
    }): Promise<T | void> => {
        return await this.writeCommands.execute({
            runtime: this.runtime,
            handle: args.handle,
            opContext: args.opContext,
            writeStrategy: args.writeStrategy,
            intents: args.intents ?? []
        })
    }
}
