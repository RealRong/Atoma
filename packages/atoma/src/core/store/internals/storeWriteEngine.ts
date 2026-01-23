import { createActionId } from '../../operationContext'
import { defaultSnowflakeGenerator } from './idGenerator'
import type {
    CoreRuntime,
    Entity,
    LifecycleHooks,
    OperationContext,
    PartialWithId,
    StoreApi,
    StoreDispatchEvent,
    WriteStrategy,
    WriteTicket
} from '../../types'
import type { EntityId } from '#protocol'
import type { Patch } from 'immer'
import type { StoreHandle } from './handleTypes'

export type StoreWriteConfig = Readonly<{
    writeStrategy?: WriteStrategy
    allowImplicitFetchForWrite: boolean
}>

export type WritebackVersionUpdate = {
    key: EntityId
    version: number
}

export type StoreWritebackArgs<T extends Entity> = {
    upserts?: T[]
    deletes?: EntityId[]
    versionUpdates?: WritebackVersionUpdate[]
}

type ChangedIds = ReadonlyArray<EntityId> | ReadonlySet<EntityId>

type StoreHandleManagerLike = {
    requireStoreHandle: <T extends Entity>(store: StoreApi<T, any>, tag: string) => StoreHandle<T>
    getStoreSnapshot: <T extends Entity>(store: StoreApi<T, any>, tag?: string) => ReadonlyMap<EntityId, T>
}

export class StoreWriteEngine {
    async prepareForAdd<T extends Entity>(
        clientRuntime: CoreRuntime,
        handle: StoreHandle<T>,
        item: Partial<T>,
        opContext?: OperationContext
    ): Promise<PartialWithId<T>> {
        let initedObj = this.initBaseObject<T>(item, handle.idGenerator)
        initedObj = await this.runBeforeSave(handle.hooks, initedObj, 'add')
        const processed = await clientRuntime.dataProcessor.inbound(handle, initedObj as T, opContext)
        return this.requireProcessed(processed as PartialWithId<T> | undefined, 'prepareForAdd')
    }

    async prepareForUpdate<T extends Entity>(
        clientRuntime: CoreRuntime,
        handle: StoreHandle<T>,
        base: PartialWithId<T>,
        patch: PartialWithId<T>,
        opContext?: OperationContext
    ): Promise<PartialWithId<T>> {
        let merged = Object.assign({}, base, patch, {
            updatedAt: Date.now(),
            createdAt: (base as any).createdAt ?? Date.now(),
            id: patch.id
        }) as PartialWithId<T>

        merged = await this.runBeforeSave(handle.hooks, merged, 'update')
        const processed = await clientRuntime.dataProcessor.inbound(handle, merged as T, opContext)
        return this.requireProcessed(processed as PartialWithId<T> | undefined, 'prepareForUpdate')
    }

    async runBeforeSave<T>(
        hooks: LifecycleHooks<T> | undefined,
        item: PartialWithId<T>,
        action: 'add' | 'update'
    ): Promise<PartialWithId<T>> {
        if (hooks?.beforeSave) {
            return await hooks.beforeSave({ action, item })
        }
        return item
    }

    async runAfterSave<T>(
        hooks: LifecycleHooks<T> | undefined,
        item: PartialWithId<T>,
        action: 'add' | 'update'
    ): Promise<void> {
        if (hooks?.afterSave) {
            await hooks.afterSave({ action, item })
        }
    }

    ensureActionId(opContext: OperationContext | undefined): OperationContext | undefined {
        if (!opContext) {
            return {
                scope: 'default',
                origin: 'user',
                actionId: createActionId()
            }
        }
        if (typeof opContext.actionId === 'string' && opContext.actionId) return opContext
        return {
            ...opContext,
            actionId: createActionId()
        }
    }

    ignoreTicketRejections(ticket: WriteTicket) {
        void ticket.enqueued.catch(() => {
            // avoid unhandled rejection when optimistic writes never await enqueued
        })
        void ticket.confirmed.catch(() => {
            // avoid unhandled rejection when optimistic writes never await confirmed
        })
    }

    dispatch<T extends Entity>(clientRuntime: CoreRuntime, event: StoreDispatchEvent<T>) {
        clientRuntime.mutation.api.dispatch(event)
    }

    bulkAdd<T>(items: PartialWithId<T>[], data: Map<EntityId, T>): Map<EntityId, T> {
        if (!items.length) return data

        let next = data
        let changed = false
        const ensure = () => {
            if (!changed) {
                next = new Map(data)
                changed = true
            }
            return next
        }

        for (const item of items) {
            const id = item.id
            const had = next.has(id)
            const prev = next.get(id)
            if (!had || prev !== (item as any)) {
                ensure().set(id, item as any)
            }
        }

        return next
    }

    bulkRemove<T>(ids: EntityId[], data: Map<EntityId, T>): Map<EntityId, T> {
        if (!ids.length) return data

        let next = data
        let changed = false
        const ensure = () => {
            if (!changed) {
                next = new Map(data)
                changed = true
            }
            return next
        }

        for (const id of ids) {
            if (next.has(id)) {
                ensure().delete(id)
            }
        }

        return next
    }

    commitAtomMapUpdate<T extends Entity>(params: {
        handle: StoreHandle<T>
        before: Map<EntityId, T>
        after: Map<EntityId, T>
    }) {
        const { handle, before, after } = params
        const { jotaiStore, atom, indexes } = handle

        if (before === after) return

        jotaiStore.set(atom, after)
        indexes?.applyMapDiff(before, after)
    }

    commitAtomMapUpdateDelta<T extends Entity>(params: {
        handle: StoreHandle<T>
        before: Map<EntityId, T>
        after: Map<EntityId, T>
        changedIds: ChangedIds
    }) {
        const { handle, before, after, changedIds } = params
        const { jotaiStore, atom, indexes } = handle

        if (before === after) return

        const size = Array.isArray(changedIds)
            ? changedIds.length
            : (changedIds as ReadonlySet<EntityId>).size
        if (size === 0) return

        jotaiStore.set(atom, after)
        indexes?.applyChangedIds(before, after, changedIds)
    }

    async applyWriteback<T extends Entity>(
        clientRuntime: CoreRuntime,
        handle: StoreHandle<T>,
        args: StoreWritebackArgs<T>
    ): Promise<void> {
        const upserts = args.upserts ?? []
        const deletes = args.deletes ?? []
        const versionUpdates = args.versionUpdates ?? []

        if (!upserts.length && !deletes.length && !versionUpdates.length) return

        const before = handle.jotaiStore.get(handle.atom)
        let after: Map<EntityId, T> | null = null
        const changedIds = new Set<EntityId>()

        const ensureAfter = () => {
            if (!after) after = new Map(before)
            return after
        }

        const getMap = () => after ?? before

        for (const id of deletes) {
            const mapRef = getMap()
            if (!mapRef.has(id)) continue
            ensureAfter().delete(id)
            changedIds.add(id)
        }

        for (const raw of upserts) {
            const processed = await clientRuntime.dataProcessor.writeback(handle, raw)
            if (!processed) continue
            const id = (processed as any).id as EntityId

            const mapRef = getMap()
            const existing = mapRef.get(id)
            const existed = mapRef.has(id)

            const item = existing ? this.preserveReferenceShallow(existing, processed) : processed
            if (existed && existing === item) continue

            ensureAfter().set(id, item)
            changedIds.add(id)
        }

        if (versionUpdates.length) {
            const versionByKey = new Map<EntityId, number>()
            for (const v of versionUpdates) {
                versionByKey.set(v.key, v.version)
            }

            for (const [key, version] of versionByKey.entries()) {
                const mapRef: any = getMap() as any
                const cur = mapRef.get(key) as any
                if (!cur || typeof cur !== 'object') continue
                if (cur.version === version) continue

                ensureAfter().set(key, { ...cur, version } as any)
                changedIds.add(key)
            }
        }

        if (changedIds.size === 0) return
        if (!after) after = new Map(before)
        const afterMap = after

        for (const id of Array.from(changedIds)) {
            const beforeHas = before.has(id)
            const afterHas = afterMap.has(id)
            if (beforeHas !== afterHas) continue
            if (before.get(id) === afterMap.get(id)) {
                changedIds.delete(id)
            }
        }

        if (changedIds.size === 0) return
        this.commitAtomMapUpdateDelta({
            handle,
            before,
            after: afterMap,
            changedIds
        })
    }

    private initBaseObject<T>(obj: Partial<T>, idGenerator?: () => EntityId): PartialWithId<T> {
        const generator = idGenerator || defaultSnowflakeGenerator
        const now = Date.now()
        return {
            ...(obj as any),
            id: (obj as any).id || generator(),
            updatedAt: now,
            createdAt: now
        } as PartialWithId<T>
    }

    private requireProcessed<T>(value: T | undefined, tag: string): T {
        if (value === undefined) {
            throw new Error(`[Atoma] ${tag}: dataProcessor returned empty`)
        }
        return value
    }

    preserveReferenceShallow<T>(existing: T | undefined, incoming: T): T {
        if (existing === undefined || existing === null) return incoming
        if (existing === incoming) return existing

        if (typeof existing !== 'object' || existing === null) return incoming
        if (typeof incoming !== 'object' || incoming === null) return incoming
        if (Array.isArray(existing) || Array.isArray(incoming)) return incoming

        const a = existing as any
        const b = incoming as any

        for (const k in a) {
            if (!Object.prototype.hasOwnProperty.call(a, k)) continue
            if (a[k] !== b[k]) return incoming
        }
        for (const k in b) {
            if (!Object.prototype.hasOwnProperty.call(b, k)) continue
            if (b[k] !== a[k]) return incoming
        }

        return existing
    }
}

export class RuntimeStoreWriteEngine {
    constructor(
        private runtime: CoreRuntime,
        private getStore: (name: string) => StoreApi<any, any>,
        private handleManager: StoreHandleManagerLike
    ) {}

    applyWriteback = async (storeName: string, args: StoreWritebackArgs<any>) => {
        const name = String(storeName)
        const store = this.getStore(name)
        const handle = this.handleManager.requireStoreHandle(store, `runtime.applyWriteback:${name}`)
        await storeWriteEngine.applyWriteback(this.runtime, handle, args)
    }

    dispatchPatches = (args: { storeName: string; patches: Patch[]; inversePatches: Patch[]; opContext: OperationContext }) => {
        const storeName = String(args.storeName)
        const store = this.getStore(storeName)
        const handle = this.handleManager.requireStoreHandle(store, `runtime.dispatchPatches:${storeName}`)
        return new Promise<void>((resolve, reject) => {
            storeWriteEngine.dispatch(this.runtime, {
                type: 'patches',
                patches: args.patches,
                inversePatches: args.inversePatches,
                handle,
                opContext: args.opContext,
                onSuccess: resolve,
                onFail: (error?: Error) => reject(error ?? new Error('[Atoma] runtime: patches 写入失败'))
            } as any)
        })
    }

    getStoreSnapshot = (storeName: string) => {
        const name = String(storeName)
        const store = this.getStore(name)
        return this.handleManager.getStoreSnapshot(store, `runtime.snapshot:${name}`)
    }
}

export const storeWriteEngine = new StoreWriteEngine()
