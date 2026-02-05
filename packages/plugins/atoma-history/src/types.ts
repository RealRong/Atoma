import type { Patch } from 'immer'
import type { OperationContext } from 'atoma-types/core'

export interface PatchMetadata {
    storeName: string
    databaseName?: string
    timestamp: number
    baseVersion?: number
    etag?: string
    traceId?: string
}

export interface HistoryChange {
    patches: Patch[]
    inversePatches: Patch[]
    storeName: string
    databaseName?: string
    timestamp: number
}

export type ChangeRecord = Readonly<{
    storeName: string
    patches: Patch[]
    inversePatches: Patch[]
    ctx: OperationContext
}>

export type ActionRecord = {
    scope: string
    actionId: string
    origin: 'user'
    label?: string
    changes: ChangeRecord[]
}

export type UndoStack = {
    undo: ActionRecord[]
    redo: ActionRecord[]
}
