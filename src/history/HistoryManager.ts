import { Patch, applyPatches } from 'immer'
import { PrimitiveAtom } from 'jotai/vanilla'
import { globalStore } from '../core/BaseStore'
import { IAdapter, PatchMetadata } from '../core/types'
import { globalIndexRegistry } from '../core/indexes/IndexRegistry'
import { IndexSynchronizer } from '../core/indexes/IndexSynchronizer'
import type { DevtoolsBridge } from '../devtools/types'
import { registerGlobalHistory } from '../devtools/global'

/**
 * History record for undo/redo
 */
export interface HistoryRecord {
    patches: Patch[]
    inversePatches: Patch[]
    atom: PrimitiveAtom<any>
    adapter: IAdapter<any>  // Store adapter instance for persistence
    timestamp: number
}

import { createStore } from 'jotai/vanilla'

/**
 * History manager configuration
 */
export interface HistoryManagerConfig {
    /** Maximum number of history records to keep */
    maxStackSize?: number

    /** Enable debug logging */
    debug?: boolean

    /** Persist history changes to adapter (default: true) */
    persist?: boolean

    /** Custom Jotai store instance (optional, defaults to globalStore) */
    store?: ReturnType<typeof createStore>

    /** Rollback local state on persistence failure (default: false) */
    rollbackOnFailure?: boolean

    /** Callback when persistence fails */
    onPersistenceFailure?: (error: Error, patches: Patch[]) => void

    /** Devtools bridge（可选） */
    devtools?: DevtoolsBridge

    /** 名称（devtools 标识用） */
    name?: string
}

/**
 * HistoryManager - Manages undo/redo stack
 * 
 * Usage:
 * ```typescript
 * import { HistoryManager } from 'atoma'
 * 
 * const history = new HistoryManager({ maxStackSize: 50 })
 * 
 * // 新架构下请通过 StoreContext 注入 history callback：
 * // context.historyRecorder.setCallback((patches, inversePatches, atom, adapter) => {
 * //   history.record(patches, inversePatches, atom, adapter)
 * // })
 * 
 * // Later
 * history.undo()
 * history.redo()
 * ```
 */
export class HistoryManager {
    private undoStack: HistoryRecord[] = []
    private redoStack: HistoryRecord[] = []
    private config: Required<Omit<HistoryManagerConfig, 'store' | 'devtools' | 'name'>> & {
        store: any
        devtools?: DevtoolsBridge
        name: string
    }
    private isApplying = false
    private devtools?: DevtoolsBridge
    private name: string

    constructor(config: HistoryManagerConfig = {}) {
        this.config = {
            maxStackSize: config.maxStackSize ?? 50,
            debug: config.debug ?? false,
            persist: config.persist ?? true,  // Default to persist
            store: config.store || globalStore,
            rollbackOnFailure: config.rollbackOnFailure ?? false,
            onPersistenceFailure: config.onPersistenceFailure || (() => { }),
            devtools: config.devtools,
            name: config.name || 'history'
        }
        this.name = config.name || 'history'
        if (config.devtools) {
            this.devtools = config.devtools
        } else {
            // 注册到全局（延迟获取 bridge）
            registerGlobalHistory({ name: this.name, snapshot: () => this.buildSnapshot() })
        }
    }

    /**
     * Record a change for undo/redo
     */
    record(
        patches: Patch[],
        inversePatches: Patch[],
        atom: PrimitiveAtom<any>,
        adapter: IAdapter<any>
    ): void {
        // Don't record if we're currently applying undo/redo
        if (this.isApplying) {
            return
        }

        const record: HistoryRecord = {
            patches,
            inversePatches,
            atom,
            adapter,
            timestamp: Date.now()
        }

        this.undoStack.push(record)

        // Limit stack size
        if (this.undoStack.length > this.config.maxStackSize) {
            this.undoStack.shift()
        }

        // Clear redo stack on new change
        this.redoStack = []

        if (this.config.debug) {
            console.log('[HistoryManager] Recorded change:', {
                patchCount: patches.length,
                stackSize: this.undoStack.length
            })
        }

        this.emitSnapshot()
    }

    /**
     * Undo last change
     */
    async undo(): Promise<{ success: boolean; error?: Error }> {
        if (!this.canUndo()) {
            if (this.config.debug) {
                console.log('[HistoryManager] Cannot undo: stack is empty')
            }
            return { success: false }
        }

        const record = this.undoStack.pop()!
        this.isApplying = true

        try {
            // Apply inverse patches to revert the change
            await this.applyPatchesToAtom(record.atom, record.inversePatches, record.adapter)

            // Move to redo stack
            this.redoStack.push(record)

            if (this.config.debug) {
                console.log('[HistoryManager] Undo applied:', {
                    patchCount: record.inversePatches.length,
                    undoStackSize: this.undoStack.length,
                    redoStackSize: this.redoStack.length
                })
            }

            return { success: true }
        } finally {
            this.isApplying = false
            this.emitSnapshot()
        }
    }

    /**
     * Redo previously undone change
     */
    async redo(): Promise<{ success: boolean; error?: Error }> {
        if (!this.canRedo()) {
            if (this.config.debug) {
                console.log('[HistoryManager] Cannot redo: stack is empty')
            }
            return { success: false }
        }

        const record = this.redoStack.pop()!
        this.isApplying = true

        try {
            // Apply forward patches to redo the change
            await this.applyPatchesToAtom(record.atom, record.patches, record.adapter)

            // Move back to undo stack
            this.undoStack.push(record)

            if (this.config.debug) {
                console.log('[HistoryManager] Redo applied:', {
                    patchCount: record.patches.length,
                    undoStackSize: this.undoStack.length,
                    redoStackSize: this.redoStack.length
                })
            }

            return { success: true }
        } finally {
            this.isApplying = false
            this.emitSnapshot()
        }
    }

    /**
     * Check if undo is available
     */
    canUndo(): boolean {
        return this.undoStack.length > 0
    }

    /**
     * Check if redo is available
     */
    canRedo(): boolean {
        return this.redoStack.length > 0
    }

    private buildSnapshot() {
        const entries = this.undoStack.slice(-20).map((rec, idx) => ({
            index: Math.max(0, this.undoStack.length - 20) + idx,
            action: 'update' as const,
            patchCount: rec.patches.length,
            id: undefined
        }))
        return {
            pointer: this.undoStack.length,
            length: this.undoStack.length + this.redoStack.length,
            entries
        }
    }

    private emitSnapshot() {
        if (!this.devtools) return
        if (this.devtools) {
            const entries = this.undoStack.slice(-20).map((rec, idx) => ({
                index: Math.max(0, this.undoStack.length - 20) + idx,
                action: 'update' as const,
                patchCount: rec.patches.length,
                id: undefined
            }))
            this.devtools.emit({
                type: 'history-snapshot',
                payload: {
                    name: this.name,
                    pointer: this.undoStack.length,
                    length: this.undoStack.length + this.redoStack.length,
                    entries
                }
            })
        }
    }

    /**
     * Clear all history
     */
    clear(): void {
        this.undoStack = []
        this.redoStack = []

        if (this.config.debug) {
            console.log('[HistoryManager] History cleared')
        }
    }

    /**
     * Get current state
     */
    getState() {
        return {
            undoCount: this.undoStack.length,
            redoCount: this.redoStack.length,
            canUndo: this.canUndo(),
            canRedo: this.canRedo()
        }
    }

    /**
     * Apply patches to atom (with adapter persistence)
     */
    private async applyPatchesToAtom(
        atom: PrimitiveAtom<any>,
        patches: Patch[],
        adapter: IAdapter<any>
    ): Promise<void> {
        const currentValue = this.config.store.get(atom)

        if (currentValue) {
            const newValue = applyPatches(currentValue, patches)
            this.config.store.set(atom, newValue)
            const indexManager = globalIndexRegistry.get(atom as any)
            if (indexManager) {
                IndexSynchronizer.applyPatches(indexManager, currentValue, newValue, patches)
            }

            // Persist to adapter if enabled
            if (this.config.persist) {
                try {
                    const metadata: PatchMetadata = {
                        atom,
                        databaseName: adapter.name,
                        timestamp: Date.now(),
                        baseVersion: Date.now()
                    }

                    if (adapter.applyPatches) {
                        await adapter.applyPatches(patches, metadata)
                    } else {
                        // Fallback: manually apply patches as put/delete operations
                        await this.applyPatchesViaOperations(adapter, patches, currentValue)
                    }

                    if (this.config.debug) {
                        console.log('[HistoryManager] Persisted patches to adapter:', {
                            adapterName: adapter.name,
                            patchCount: patches.length
                        })
                    }
                } catch (error) {
                    const err = error instanceof Error ? error : new Error(String(error))
                    console.error('[HistoryManager] Failed to persist patches:', err)

                    // Notify callback
                    this.config.onPersistenceFailure?.(err, patches)

                    // Rollback if enabled
                    if (this.config.rollbackOnFailure) {
                        // Apply inverse patches to revert the change (since we are in applyPatchesToAtom, 
                        // we need the inverse of the patches we just applied. 
                        // But wait, applyPatchesToAtom is called with either patches (redo) or inversePatches (undo).
                        // So we need to know the inverse of what we just applied.
                        // However, applyPatchesToAtom doesn't know if it's undo or redo, or what the inverse is.
                        // We should probably pass the inverse patches to this function or handle rollback differently.
                        // Actually, to rollback, we just need to set the atom back to currentValue (the value before update).
                        this.config.store.set(atom, currentValue)
                        if (indexManager) {
                            IndexSynchronizer.applyMapDiff(indexManager, newValue, currentValue)
                        }

                        if (this.config.debug) {
                            console.log('[HistoryManager] Rolled back local change due to persistence failure')
                        }
                    }

                    // Re-throw to let caller know
                    throw err
                }
            }

            if (this.config.debug) {
                console.log('[HistoryManager] Applied patches to atom:', {
                    adapterName: adapter.name,
                    patchCount: patches.length
                })
            }
        }
    }

    /**
     * Convert patches to put/delete operations (fallback when adapter doesn't support applyPatches)
     */
    private async applyPatchesViaOperations(
        adapter: IAdapter<any>,
        patches: Patch[],
        baseValue: any
    ): Promise<void> {
        const putActions: any[] = []
        const deleteKeys: (string | number)[] = []

        patches.forEach(patch => {
            if (patch.op === 'add' || patch.op === 'replace') {
                putActions.push(patch.value)
            } else if (patch.op === 'remove') {
                const key = patch.path[0] as any
                deleteKeys.push(key)
            }
        })

        if (putActions.length) {
            await adapter.bulkPut(putActions)
        }
        if (deleteKeys.length) {
            await adapter.bulkDelete(deleteKeys)
        }
    }
}

/**
 * Apply patches directly to an atom
 * This is exported for advanced use cases
 */
export function applyPatchesOnAtom(
    atom: PrimitiveAtom<any>,
    patches: Patch[],
    store: any = globalStore
): void {
    const currentValue = store.get(atom)
    if (currentValue) {
        const next = applyPatches(currentValue, patches)
        store.set(atom, next)
        const indexManager = globalIndexRegistry.get(atom as any)
        if (indexManager) {
            IndexSynchronizer.applyPatches(indexManager, currentValue, next, patches)
        }
    }
}
