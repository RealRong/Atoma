import type { ActionContext, Entity, StoreChange } from '../core'

export type AtomaHistory = Readonly<{
    canUndo: (scope?: string) => boolean
    canRedo: (scope?: string) => boolean
    clear: (scope?: string) => void
    undo: (scope?: string) => Promise<boolean>
    redo: (scope?: string) => Promise<boolean>
}>

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

export type HistoryRecordArgs = Readonly<{
    storeName: string
    changes: ReadonlyArray<StoreChange<Entity>>
    context: ActionContext
}>

export type HistoryApplyArgs = Readonly<{
    storeName: string
    changes: ReadonlyArray<StoreChange<Entity>>
    mode: 'apply' | 'revert'
    context: ActionContext
}>

export type HistoryApply = (args: HistoryApplyArgs) => Promise<void>
