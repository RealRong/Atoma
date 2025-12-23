import type { ObservabilityContext } from '#observability'
import type { Entity, StoreAccess, StoreKey } from '../../../core/types'
import type { StoreIndexes } from '../../../core/indexes/StoreIndexes'
import { commitAtomMapUpdate } from '../../../core/store/cacheWriter'
import { validateWithSchema } from '../../../core/store/validation'
import type { StateWriteInstruction } from './types'

type StateWriterDeps<T extends Entity> = {
    getStoreAccess: () => StoreAccess<T> | undefined
}

export class StateWriter<T extends Entity> {
    constructor(private readonly deps: StateWriterDeps<T>) {}

    async applyInstructions(
        instructions: StateWriteInstruction<T>[],
        _context?: ObservabilityContext
    ): Promise<void> {
        const access = this.deps.getStoreAccess()
        if (!access) return

        const upserts: T[] = []
        const deletes: StoreKey[] = []
        const versionUpdates: Array<{ key: StoreKey; version: number }> = []

        for (const instruction of instructions) {
            if (instruction.kind === 'upsert') {
                upserts.push(...instruction.items)
                continue
            }

            if (instruction.kind === 'delete') {
                deletes.push(...instruction.keys)
                continue
            }

            if (instruction.kind === 'updateVersion') {
                versionUpdates.push({ key: instruction.key, version: instruction.version })
                continue
            }
        }

        if (upserts.length || deletes.length) {
            await this.applyRemoteWriteback(access, { upserts, deletes })
        }

        for (const { key, version } of versionUpdates) {
            this.applyVersionUpdate(access, key, version)
        }
    }

    private applyVersionUpdate(access: StoreAccess<T>, key: StoreKey, version: number) {
        const before = access.jotaiStore.get(access.atom)
        const cur = before.get(key) as any
        if (!cur || typeof cur !== 'object') return
        if (cur.version === version) return

        const after = new Map(before)
        after.set(key, { ...cur, version })
        commitAtomMapUpdate({
            jotaiStore: access.jotaiStore,
            atom: access.atom,
            before,
            after,
            context: access.context,
            indexes: (access.indexes as StoreIndexes<T>) ?? null
        })
    }

    private async applyRemoteWriteback(
        access: StoreAccess<T>,
        args: { upserts: T[]; deletes: StoreKey[] }
    ) {
        const before = access.jotaiStore.get(access.atom)
        const after = new Map(before)
        let changed = false

        args.deletes.forEach(id => {
            if (after.has(id)) {
                after.delete(id)
                changed = true
            }
        })

        const preserveReference = (incoming: T): T => {
            const existing = before.get((incoming as any).id)
            if (!existing) return incoming
            const keys = new Set([...Object.keys(existing as any), ...Object.keys(incoming as any)])
            for (const key of keys) {
                if ((existing as any)[key] !== (incoming as any)[key]) {
                    return incoming
                }
            }
            return existing
        }

        for (const raw of args.upserts) {
            const transformed = access.transform ? access.transform(raw) : raw
            const validated = await validateWithSchema(transformed, access.schema as any)
            const item = preserveReference(validated)
            const id = (item as any).id
            const prev = before.get(id)
            if (prev !== item) changed = true
            after.set((item as any).id, item)
        }

        if (!changed) return
        commitAtomMapUpdate({
            jotaiStore: access.jotaiStore,
            atom: access.atom,
            before,
            after,
            context: access.context,
            indexes: (access.indexes as StoreIndexes<T>) ?? null
        })
    }
}
