import type { Entity } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import type { StoreWritebackArgs, StoreWritebackResult, StoreWritebackOptions } from 'atoma-types/core'
import { StoreWriteUtils } from './StoreWriteUtils'

class StoreMapEditor<T extends Entity> {
    private after: Map<EntityId, T> | null = null
    readonly changedIds = new Set<EntityId>()

    constructor(
        private readonly before: Map<EntityId, T>,
        private readonly preserve: (existing: T, incoming: T) => T
    ) {}

    private ensureAfter = () => {
        if (!this.after) this.after = new Map(this.before)
        return this.after
    }

    private getMap = () => this.after ?? this.before

    remove = (id: EntityId) => {
        const mapRef = this.getMap()
        if (!mapRef.has(id)) return
        this.ensureAfter().delete(id)
        this.changedIds.add(id)
    }

    upsert = (item: T) => {
        const id = (item as any).id as EntityId
        if (id === undefined || id === null) return

        const mapRef = this.getMap()
        const existed = mapRef.has(id)
        const existing = mapRef.get(id)
        const next = existing ? this.preserve(existing, item) : item
        if (existed && existing === next) return

        this.ensureAfter().set(id, next)
        this.changedIds.add(id)
    }

    updateVersion = (id: EntityId, version: number) => {
        const mapRef: any = this.getMap() as any
        const cur = mapRef.get(id) as any
        if (!cur || typeof cur !== 'object') return
        if (cur.version === version) return

        this.ensureAfter().set(id, { ...cur, version } as any)
        this.changedIds.add(id)
    }

    finalize = (): StoreWritebackResult<T> | null => {
        if (!this.after || this.changedIds.size === 0) return null

        const after = this.after
        for (const id of Array.from(this.changedIds)) {
            const beforeHas = this.before.has(id)
            const afterHas = after.has(id)
            if (beforeHas !== afterHas) continue
            if (this.before.get(id) === after.get(id)) {
                this.changedIds.delete(id)
            }
        }

        if (this.changedIds.size === 0) return null
        return { before: this.before, after, changedIds: this.changedIds }
    }
}

export function applyWritebackToMap<T extends Entity>(
    before: Map<EntityId, T>,
    args: StoreWritebackArgs<T>,
    options?: StoreWritebackOptions<T>
): StoreWritebackResult<T> | null {
    const upserts = args.upserts ?? []
    const deletes = args.deletes ?? []
    const versionUpdates = args.versionUpdates ?? []

    if (!upserts.length && !deletes.length && !versionUpdates.length) return null

    const preserve = options?.preserve ?? StoreWriteUtils.preserveReferenceShallow
    const editor = new StoreMapEditor(before, preserve)

    for (const id of deletes) {
        editor.remove(id)
    }

    for (const item of upserts) {
        if (!item) continue
        editor.upsert(item)
    }

    if (versionUpdates.length) {
        const versionByKey = new Map<EntityId, number>()
        for (const v of versionUpdates) {
            if (!v) continue
            versionByKey.set(v.key, v.version)
        }

        for (const [key, version] of versionByKey.entries()) {
            editor.updateVersion(key, version)
        }
    }

    return editor.finalize()
}
