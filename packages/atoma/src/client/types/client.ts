import type { CoreStore, Entity } from '#core'
import type { SyncStore } from './syncStore'
import type { InferRelationsFromSchema } from './relations'
import type { AtomaSchema } from './schema'

export type AtomaClientDevtools = {
    id: string
    label?: string
    snapshot: () => any
    subscribe: (fn: (e: { type: string; payload?: any }) => void) => () => void
    stores: {
        list: () => Array<{ name: string }>
        snapshot: (name?: string) => any[]
    }
    indexes: {
        list: () => Array<{ name: string }>
        snapshot: (name?: string) => any[]
    }
    sync: {
        snapshot: () => any
    }
    history: {
        snapshot: () => any
    }
    dispose: () => void
}

export type AtomaStore<
    Entities extends Record<string, Entity>,
    Schema extends AtomaSchema<Entities>,
    Name extends keyof Entities & string
> = CoreStore<Entities[Name], InferRelationsFromSchema<Entities, Schema, Name>> & {
    /**
     * queued writes（outbox）视图：
     * - 写入会入队（persist=outbox），由 sync 引擎负责后续 push
     * - server-assigned create（createServerAssigned*）在 outbox 下不可用
     */
    Outbox: SyncStore<Entities[Name], InferRelationsFromSchema<Entities, Schema, Name>>
}

export type AtomaHistory = {
    canUndo: (scope?: string) => boolean
    canRedo: (scope?: string) => boolean
    clear: (scope?: string) => void
    undo: (args?: { scope?: string }) => Promise<boolean>
    redo: (args?: { scope?: string }) => Promise<boolean>
}

export type AtomaSyncStatus = {
    started: boolean
    configured: boolean
}

export type AtomaSyncStartMode = 'pull-only' | 'subscribe-only' | 'pull+subscribe' | 'push-only' | 'full'

export type AtomaSync = {
    start: (mode?: AtomaSyncStartMode) => void
    stop: () => void
    dispose: () => void
    status: () => AtomaSyncStatus
    pull: () => Promise<void>
    push: () => Promise<void>
}

export type AtomaClient<
    Entities extends Record<string, Entity>,
    Schema extends AtomaSchema<Entities> = AtomaSchema<Entities>
> = {
    Store: <Name extends keyof Entities & string>(name: Name) => AtomaStore<Entities, Schema, Name>
    Sync: AtomaSync
    History: AtomaHistory
    Devtools: AtomaClientDevtools
}
