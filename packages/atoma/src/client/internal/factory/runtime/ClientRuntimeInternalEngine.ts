import type { CoreRuntime, PersistWriteback, StoreToken } from '#core'
import type { OperationContext } from '#core'
import type { StoreHandle } from '#core/store/internals/handleTypes'
import { storeWriteEngine } from '#core/store/internals/storeWriteEngine'
import type { ObservabilityContext } from '#observability'
import { Protocol } from '#protocol'
import type { EntityId, WriteItem, WriteResultData } from '#protocol'
import type { Patch } from 'immer'

const desiredBaseVersionFromTargetVersion = (version: unknown): number | undefined => {
    if (typeof version !== 'number' || !Number.isFinite(version) || version <= 1) return undefined
    return Math.floor(version) - 1
}

const ensureWriteItemsOk = (data: WriteResultData, message: string) => {
    const results = Array.isArray((data as any)?.results) ? (data as any).results : []
    for (const r of results) {
        if (r && typeof r === 'object' && (r as any).ok === false) {
            const err: any = new Error(message)
            ;(err as any).error = (r as any).error
            ;(err as any).current = (r as any).current
            throw err
        }
    }
}

export class ClientRuntimeInternalEngine {
    private readonly mirrorWritebackToStore: boolean
    private readonly now: () => number

    constructor(
        private readonly runtime: CoreRuntime,
        opts?: Readonly<{
            mirrorWritebackToStore?: boolean
            now?: () => number
        }>
    ) {
        this.mirrorWritebackToStore = opts?.mirrorWritebackToStore === true
        this.now = opts?.now ?? (() => Date.now())
    }

    private resolveHandle = (storeName: string, tag: string): StoreHandle<any> => {
        const name = String(storeName)
        const key = this.runtime.toStoreKey(name)
        const direct = this.runtime.handles.get(key)
        if (direct) return direct

        // Lazy creation: create store/handle via runtime store resolver (client runtime does).
        try {
            this.runtime.stores.resolveStore(name)
        } catch {
            // ignore
        }

        const after = this.runtime.handles.get(key)
        if (after) return after

        throw new Error(`[Atoma] ${tag}: 未找到 store handle（storeName=${name}）`)
    }

    getStoreSnapshot = (storeName: string) => {
        const handle = this.resolveHandle(storeName, `runtime.snapshot:${String(storeName)}`)
        return handle.jotaiStore.get(handle.atom) as ReadonlyMap<EntityId, any>
    }

    applyWriteback = async (storeName: string, args: PersistWriteback<any>) => {
        const handle = this.resolveHandle(storeName, `runtime.applyWriteback:${String(storeName)}`)
        await storeWriteEngine.applyWriteback(this.runtime, handle, args as any)
    }

    dispatchPatches = (args: { storeName: string; patches: Patch[]; inversePatches: Patch[]; opContext: OperationContext }) => {
        const storeName = String(args.storeName)
        const handle = this.resolveHandle(storeName, `runtime.dispatchPatches:${storeName}`)
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

    commitWriteback = async (
        storeName: StoreToken,
        writeback: PersistWriteback<any>,
        options?: { context?: ObservabilityContext }
    ) => {
        const name = String(storeName)
        await this.applyWriteback(name, writeback)

        // Only mirror into the durable store backend when Store is configured as durable.
        if (!this.mirrorWritebackToStore) return

        const upserts = Array.isArray(writeback?.upserts) ? writeback.upserts : []
        const deletes = Array.isArray(writeback?.deletes) ? writeback.deletes : []
        const versionUpdates = Array.isArray(writeback?.versionUpdates) ? writeback.versionUpdates : []

        if (!upserts.length && !deletes.length && !versionUpdates.length) return

        const handle = this.resolveHandle(name, `runtime.commitWriteback:${name}`)
        const snapshot = handle.jotaiStore.get(handle.atom) as ReadonlyMap<string, any>

        const newWriteItemMeta = (): import('#protocol').WriteItemMeta => {
            return Protocol.ops.meta.newWriteItemMeta({ now: this.now })
        }

        if (upserts.length) {
            const items: WriteItem[] = []
            for (const u of upserts) {
                const id = (u as any)?.id
                if (typeof id !== 'string' || !id) continue

                // Persist the post-writeback in-memory value (already processed via dataProcessor.writeback),
                // then let runtime.io apply outbound processing for durable storage.
                const value = snapshot.get(id)
                if (!value) continue

                const baseVersion = desiredBaseVersionFromTargetVersion((value as any)?.version)
                items.push({
                    entityId: id,
                    ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
                    value,
                    meta: newWriteItemMeta()
                } as any)
            }
            if (items.length) {
                const data = await this.runtime.io.write(
                    handle,
                    { action: 'upsert', items, options: { merge: false, upsert: { mode: 'loose' } } },
                    options?.context
                )
                ensureWriteItemsOk(data, '[Atoma] writeback.commit: mirror upsert failed')
            }
        }

        if (deletes.length) {
            const { data: currentItems } = await this.runtime.io.query<any>(
                handle,
                { where: { id: { in: deletes } } } as any,
                options?.context
            )

            const currentById = new Map<string, any>()
            for (const row of currentItems) {
                const id = (row as any)?.id
                if (typeof id === 'string' && id) currentById.set(id, row)
            }

            const items: WriteItem[] = []
            for (const id of deletes) {
                const row = currentById.get(String(id))
                if (!row || typeof row !== 'object') continue
                const baseVersion = (row as any).version
                if (!(typeof baseVersion === 'number' && Number.isFinite(baseVersion) && baseVersion > 0)) {
                    throw new Error(`[Atoma] writeback.commit: mirror delete requires baseVersion (missing version for id=${String(id)})`)
                }
                items.push({
                    entityId: String(id),
                    baseVersion,
                    meta: newWriteItemMeta()
                } as any)
            }

            if (items.length) {
                const data = await this.runtime.io.write(handle, { action: 'delete', items }, options?.context)
                ensureWriteItemsOk(data, '[Atoma] writeback.commit: mirror delete failed')
            }
        }

        if (versionUpdates.length) {
            const versionByKey = new Map<string, number>()
            for (const v of versionUpdates) {
                const key = String((v as any)?.key ?? '')
                const version = (v as any)?.version
                if (!key) continue
                if (!(typeof version === 'number' && Number.isFinite(version) && version > 0)) continue
                versionByKey.set(key, Math.floor(version))
            }

            const upsertedKeys = new Set<string>()
            for (const u of upserts) {
                const id = (u as any)?.id
                if (typeof id === 'string' && id) upsertedKeys.add(id)
            }

            const toUpdate = Array.from(versionByKey.keys()).filter(k => !upsertedKeys.has(k))
            if (toUpdate.length) {
                const { data: currentItems } = await this.runtime.io.query<any>(
                    handle,
                    { where: { id: { in: toUpdate } } } as any,
                    options?.context
                )

                const items: WriteItem[] = []
                for (const row of currentItems) {
                    const id = (row as any)?.id
                    if (typeof id !== 'string' || !id) continue
                    const nextVersion = versionByKey.get(id)
                    if (nextVersion === undefined) continue

                    const baseVersion = desiredBaseVersionFromTargetVersion(nextVersion)
                    const value = snapshot.get(id) ?? row
                    items.push({
                        entityId: id,
                        ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
                        value: { ...(value as any), version: nextVersion },
                        meta: newWriteItemMeta()
                    } as any)
                }

                if (items.length) {
                    const data = await this.runtime.io.write(
                        handle,
                        { action: 'upsert', items, options: { merge: true, upsert: { mode: 'loose' } } },
                        options?.context
                    )
                    ensureWriteItemsOk(data, '[Atoma] writeback.commit: mirror versionUpdate failed')
                }
            }
        }
    }
}
