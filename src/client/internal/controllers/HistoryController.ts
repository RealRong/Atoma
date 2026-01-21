import type { OperationContext } from '#core'
import type { Patch } from 'immer'
import type { AtomaHistory } from '#client/types'
import type { ClientRuntimeInternal } from '#client/internal/types'

export class HistoryController {
    readonly history: AtomaHistory
    readonly devtools: Readonly<{
        snapshot: () => { scopes: Array<{ scope: string; canUndo: boolean; canRedo: boolean }> }
    }>
    readonly dispose: () => void

    private readonly runtime: ClientRuntimeInternal
    private readonly historyManager: ClientRuntimeInternal['mutation']['history']

    constructor(args: { runtime: ClientRuntimeInternal }) {
        this.runtime = args.runtime
        this.historyManager = this.runtime.mutation.history

        this.history = {
            canUndo: (scope?: string) => this.historyManager.canUndo(this.scopeKey(scope)),
            canRedo: (scope?: string) => this.historyManager.canRedo(this.scopeKey(scope)),
            clear: (scope?: string) => this.historyManager.clear(this.scopeKey(scope)),
            undo: (undoArgs?: { scope?: string }) => {
                return this.historyManager.undo({
                    scope: this.scopeKey(undoArgs?.scope),
                    apply: this.apply
                })
            },
            redo: (redoArgs?: { scope?: string }) => {
                return this.historyManager.redo({
                    scope: this.scopeKey(redoArgs?.scope),
                    apply: this.apply
                })
            }
        }

        this.devtools = {
            snapshot: this.snapshotDevtools
        } as const

        this.dispose = () => {
            // history 由 mutation pipeline 内置维护，无需 dispose
        }
    }

    private scopeKey = (scope?: string) => String(scope || 'default')

    private dispatchPatches = (
        storeName: string,
        patches: Patch[],
        inversePatches: Patch[],
        opContext: OperationContext
    ): Promise<void> => {
        return this.runtime.internal.dispatchPatches({
            storeName,
            patches,
            inversePatches,
            opContext
        })
    }

    private apply = (applyArgs: { storeName: string; patches: Patch[]; inversePatches: Patch[]; opContext: OperationContext }) => {
        return this.dispatchPatches(applyArgs.storeName, applyArgs.patches, applyArgs.inversePatches, applyArgs.opContext)
    }

    private snapshotDevtools = () => {
        const scopes = this.historyManager.listScopes()
            .map(scope => ({
                scope,
                canUndo: this.historyManager.canUndo(scope),
                canRedo: this.historyManager.canRedo(scope)
            }))
            .sort((a, b) => a.scope.localeCompare(b.scope))
        return { scopes }
    }
}
