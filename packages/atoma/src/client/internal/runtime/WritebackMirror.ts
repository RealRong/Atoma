import type { CoreRuntime, PersistWriteback, StoreToken } from '#core'
import type { StoreHandle } from '#core/store/internals/handleTypes'
import type { ObservabilityContext } from '#observability'
import { Protocol } from '#protocol'
import type { WriteItem, WriteResultData } from '#protocol'

type MirrorOptions = {
    context?: ObservabilityContext
}

export class WritebackMirror {
    private readonly now: () => number

    constructor(
        private readonly runtime: CoreRuntime,
        opts?: Readonly<{ now?: () => number }>
    ) {
        this.now = opts?.now ?? (() => Date.now())
    }

    commit = async (storeName: StoreToken, writeback: PersistWriteback<any>, options?: MirrorOptions) => {
        const upserts = Array.isArray(writeback?.upserts) ? writeback.upserts : []
        const deletes = Array.isArray(writeback?.deletes) ? writeback.deletes : []
        const versionUpdates = Array.isArray(writeback?.versionUpdates) ? writeback.versionUpdates : []

        if (!upserts.length && !deletes.length && !versionUpdates.length) return

        const name = String(storeName)
        const handle = this.runtime.stores.resolveHandle(name, `runtime.commitWriteback:${name}`)
        const snapshot = handle.jotaiStore.get(handle.atom) as ReadonlyMap<string, any>

        if (upserts.length) {
            const items = this.collectUpsertItems(snapshot, upserts)
            if (items.length) {
                const data = await this.runtime.io.write(
                    handle,
                    { action: 'upsert', items, options: { merge: false, upsert: { mode: 'loose' } } },
                    options?.context
                )
                this.ensureWriteItemsOk(data, '[Atoma] writeback.commit: mirror upsert failed')
            }
        }

        if (deletes.length) {
            const items = await this.collectDeleteItems(handle, deletes, options?.context)
            if (items.length) {
                const data = await this.runtime.io.write(handle, { action: 'delete', items }, options?.context)
                this.ensureWriteItemsOk(data, '[Atoma] writeback.commit: mirror delete failed')
            }
        }

        if (versionUpdates.length) {
            const items = await this.collectVersionUpdateItems(handle, snapshot, upserts, versionUpdates, options?.context)
            if (items.length) {
                const data = await this.runtime.io.write(
                    handle,
                    { action: 'upsert', items, options: { merge: true, upsert: { mode: 'loose' } } },
                    options?.context
                )
                this.ensureWriteItemsOk(data, '[Atoma] writeback.commit: mirror versionUpdate failed')
            }
        }
    }

    private collectUpsertItems = (snapshot: ReadonlyMap<string, any>, upserts: ReadonlyArray<any>): WriteItem[] => {
        const items: WriteItem[] = []
        for (const u of upserts) {
            const id = (u as any)?.id
            if (typeof id !== 'string' || !id) continue

            // Persist the post-writeback in-memory value (already processed via transform.writeback),
            // then let runtime.io apply outbound processing for durable storage.
            const value = snapshot.get(id)
            if (!value) continue

            const baseVersion = this.desiredBaseVersionFromTargetVersion((value as any)?.version)
            items.push({
                entityId: id,
                ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
                value,
                meta: this.newWriteItemMeta()
            } as any)
        }
        return items
    }

    private collectDeleteItems = async (
        handle: StoreHandle<any>,
        deletes: ReadonlyArray<any>,
        context?: ObservabilityContext
    ): Promise<WriteItem[]> => {
        const ids = deletes.map(id => String(id)).filter(Boolean)
        if (!ids.length) return []

        const currentItems = await this.queryItemsByIds(handle, ids, context)
        const currentById = this.buildIdMap(currentItems)

        const items: WriteItem[] = []
        for (const id of ids) {
            const row = currentById.get(id)
            if (!row || typeof row !== 'object') continue
            const baseVersion = (row as any).version
            if (!(typeof baseVersion === 'number' && Number.isFinite(baseVersion) && baseVersion > 0)) {
                throw new Error(`[Atoma] writeback.commit: mirror delete requires baseVersion (missing version for id=${id})`)
            }
            items.push({
                entityId: id,
                baseVersion,
                meta: this.newWriteItemMeta()
            } as any)
        }

        return items
    }

    private collectVersionUpdateItems = async (
        handle: StoreHandle<any>,
        snapshot: ReadonlyMap<string, any>,
        upserts: ReadonlyArray<any>,
        versionUpdates: ReadonlyArray<any>,
        context?: ObservabilityContext
    ): Promise<WriteItem[]> => {
        const versionByKey = new Map<string, number>()
        for (const v of versionUpdates) {
            const key = String((v as any)?.key ?? '')
            const version = (v as any)?.version
            if (!key) continue
            if (!(typeof version === 'number' && Number.isFinite(version) && version > 0)) continue
            versionByKey.set(key, Math.floor(version))
        }

        if (!versionByKey.size) return []

        const upsertedKeys = new Set<string>()
        for (const u of upserts) {
            const id = (u as any)?.id
            if (typeof id === 'string' && id) upsertedKeys.add(id)
        }

        const toUpdate = Array.from(versionByKey.keys()).filter(k => !upsertedKeys.has(k))
        if (!toUpdate.length) return []

        const currentItems = await this.queryItemsByIds(handle, toUpdate, context)
        const items: WriteItem[] = []
        for (const row of currentItems) {
            const id = (row as any)?.id
            if (typeof id !== 'string' || !id) continue
            const nextVersion = versionByKey.get(id)
            if (nextVersion === undefined) continue

            const baseVersion = this.desiredBaseVersionFromTargetVersion(nextVersion)
            const value = snapshot.get(id) ?? row
            items.push({
                entityId: id,
                ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
                value: { ...(value as any), version: nextVersion },
                meta: this.newWriteItemMeta()
            } as any)
        }

        return items
    }

    private queryItemsByIds = async (handle: StoreHandle<any>, ids: string[], context?: ObservabilityContext) => {
        const { data } = await this.runtime.io.query<any>(
            handle,
            { filter: { op: 'in', field: 'id', values: ids } },
            context
        )
        return data
    }

    private buildIdMap = (items: ReadonlyArray<any>) => {
        const map = new Map<string, any>()
        for (const row of items) {
            const id = (row as any)?.id
            if (typeof id === 'string' && id) map.set(id, row)
        }
        return map
    }

    private desiredBaseVersionFromTargetVersion = (version: unknown): number | undefined => {
        if (typeof version !== 'number' || !Number.isFinite(version) || version <= 1) return undefined
        return Math.floor(version) - 1
    }

    private newWriteItemMeta = () => {
        return Protocol.ops.meta.newWriteItemMeta({ now: this.now })
    }

    private ensureWriteItemsOk = (data: WriteResultData, message: string) => {
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
}
