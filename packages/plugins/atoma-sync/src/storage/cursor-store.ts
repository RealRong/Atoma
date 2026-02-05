import { createKVStore } from '#sync/internal/kv-store'
import { defaultCompareCursor } from '#sync/policies/cursor-guard'
import type { CursorStore } from 'atoma-types/sync'

export class DefaultCursorStore implements CursorStore {
    private readonly kv = createKVStore()
    private cursor: string | undefined
    private initialized: Promise<void>

    constructor(
        private readonly storageKey: string,
        private readonly initial?: string
    ) {
        this.initialized = this.restore()
    }

    async get() {
        await this.initialized
        return this.cursor ?? this.initial
    }

    async advance(next: string): Promise<{ advanced: boolean; previous?: string }> {
        await this.initialized
        if (this.cursor === undefined) {
            const previous = this.cursor ?? this.initial
            this.cursor = next
            await this.persist()
            return { advanced: true, ...(previous !== undefined ? { previous } : {}) }
        }
        const cmp = defaultCompareCursor(this.cursor, next)
        if (cmp < 0) {
            const previous = this.cursor
            this.cursor = next
            await this.persist()
            return { advanced: true, ...(previous !== undefined ? { previous } : {}) }
        }
        return { advanced: false, previous: this.cursor }
    }

    private async persist() {
        await this.kv.set(this.storageKey, this.cursor)
    }

    private async restore() {
        const stored = await this.kv.get<any>(this.storageKey)
        if (typeof stored === 'string' && stored) {
            this.cursor = stored
        }
    }
}
