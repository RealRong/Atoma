import type { Patch } from 'immer'
import type { Atom } from 'jotai/vanilla'
import type * as Types from 'atoma-types/core'

export interface PatchMetadata {
    atom: Atom<any>
    databaseName?: string
    timestamp: number
    baseVersion?: number
    etag?: string
    traceId?: string
}

export interface HistoryChange {
    patches: Patch[]
    inversePatches: Patch[]
    atom: Atom<any>
    databaseName?: string
    timestamp: number
}

export type ChangeRecord = Readonly<{
    storeName: string
    patches: Patch[]
    inversePatches: Patch[]
    ctx: Types.OperationContext
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
