import type { CoreStore, Entity, SyncStore } from '#core'
import type { InferRelationsFromSchema } from './relations'
import type { AtomaSchema } from './schema'

export type AtomaHistory = {
    canUndo: (scope: string) => boolean
    canRedo: (scope: string) => boolean
    clear: (scope: string) => void
    undo: (args: { scope: string }) => Promise<boolean>
    redo: (args: { scope: string }) => Promise<boolean>
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
    flush: () => Promise<void>
}

export type AtomaSyncNamespace<
    Entities extends Record<string, Entity>,
    Schema extends AtomaSchema<Entities> = AtomaSchema<Entities>
> = AtomaSync & {
    Store: <Name extends keyof Entities & string>(
        name: Name
    ) => SyncStore<Entities[Name], InferRelationsFromSchema<Entities, Schema, Name>>
}

export type AtomaClient<
    Entities extends Record<string, Entity>,
    Schema extends AtomaSchema<Entities> = AtomaSchema<Entities>
> = {
    Store: <Name extends keyof Entities & string>(name: Name) => CoreStore<Entities[Name], InferRelationsFromSchema<Entities, Schema, Name>>
    Sync: AtomaSyncNamespace<Entities, Schema>
    History: AtomaHistory
}
