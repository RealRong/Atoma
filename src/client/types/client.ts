import type { CoreStore, Entity, SyncStore } from '#core'
import type { InferRelationsFromStoreOverride } from './relations'
import type { StoresConstraint } from './store'

export type AtomaHistory = {
    canUndo: (scope: string) => boolean
    canRedo: (scope: string) => boolean
    undo: (args: { scope: string }) => Promise<boolean>
    redo: (args: { scope: string }) => Promise<boolean>
}

export type AtomaSyncStatus = {
    started: boolean
    configured: boolean
}

export type AtomaSyncStartMode = 'pull-only' | 'subscribe-only' | 'pull+subscribe' | 'push-only' | 'full'

export type AtomaSync = {
    start: (args?: { mode?: AtomaSyncStartMode }) => void
    stop: () => void
    status: () => AtomaSyncStatus
    pull: () => Promise<void>
    flush: () => Promise<void>
    setSubscribed: (enabled: boolean) => void
}

export type AtomaSyncNamespace<
    Entities extends Record<string, Entity>,
    Stores extends StoresConstraint<Entities> = {}
> = AtomaSync & {
    Store: <Name extends keyof Entities & string>(
        name: Name
    ) => SyncStore<Entities[Name], InferRelationsFromStoreOverride<Entities, Stores, Name>>
}

export type AtomaClient<
    Entities extends Record<string, Entity>,
    Stores extends StoresConstraint<Entities> = {}
> = {
    Store: <Name extends keyof Entities & string>(name: Name) => CoreStore<Entities[Name], InferRelationsFromStoreOverride<Entities, Stores, Name>>
    Sync: AtomaSyncNamespace<Entities, Stores>
    History: AtomaHistory
}

