import { PrimitiveAtom } from 'jotai'
import { StoreKey } from '../types'

export type VersionMeta = {
    globalVersion: number
    fieldVersion: Map<string, number>
}

/**
 * Manages version tracking for atoms (global + field-level).
 * Kept side-effect free apart from internal maps.
 */
export class AtomVersionTracker {
    private versionMap = new WeakMap<PrimitiveAtom<Map<StoreKey, any>>, VersionMeta>()

    getVersionMeta(atom: PrimitiveAtom<Map<StoreKey, any>>): VersionMeta {
        const existing = this.versionMap.get(atom)
        if (existing) return existing
        const meta: VersionMeta = { globalVersion: 0, fieldVersion: new Map() }
        this.versionMap.set(atom, meta)
        return meta
    }

    bump(atom: PrimitiveAtom<Map<StoreKey, any>>, fields: Set<string>): void {
        const meta = this.getVersionMeta(atom)
        meta.globalVersion += 1
        fields.forEach(field => {
            if (field === 'id') return
            const current = meta.fieldVersion.get(field) || 0
            meta.fieldVersion.set(field, current + 1)
        })
    }

    getSnapshot(atom: PrimitiveAtom<Map<StoreKey, any>>, fields?: string[]): number {
        const meta = this.getVersionMeta(atom)
        if (!fields || fields.length === 0) {
            return meta.globalVersion
        }
        let acc = 0
        fields.forEach(field => {
            acc += meta.fieldVersion.get(field) ?? 0
        })
        return acc
    }
}
