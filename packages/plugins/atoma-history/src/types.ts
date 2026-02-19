import type { Entity, ActionContext, StoreChange } from 'atoma-types/core'

export interface PatchMetadata {
    storeName: string
    databaseName?: string
    timestamp: number
    baseVersion?: number
    traceId?: string
}

export interface HistoryChange {
    changes: ReadonlyArray<StoreChange<Entity>>
    storeName: string
    databaseName?: string
    timestamp: number
}

export type ChangeRecord = Readonly<{
    storeName: string
    changes: ReadonlyArray<StoreChange<Entity>>
    context: ActionContext
}>

export type ActionRecord = {
    scope: string
    id: string
    origin: 'user'
    label?: string
    changes: ChangeRecord[]
}

export type UndoStack = {
    undo: ActionRecord[]
    redo: ActionRecord[]
}
