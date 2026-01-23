import type { CoreStore, Entity } from '#core'
import type { InferRelationsFromSchema } from './relations'
import type { AtomaSchema } from './schema'
import type { PluginCapableClient } from './plugin'

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
    history: {
        snapshot: () => any
    }
    dispose: () => void
}

export type AtomaStore<
    Entities extends Record<string, Entity>,
    Schema extends AtomaSchema<Entities>,
    Name extends keyof Entities & string
> = CoreStore<Entities[Name], InferRelationsFromSchema<Entities, Schema, Name>>

export type AtomaHistory = {
    canUndo: (scope?: string) => boolean
    canRedo: (scope?: string) => boolean
    clear: (scope?: string) => void
    undo: (args?: { scope?: string }) => Promise<boolean>
    redo: (args?: { scope?: string }) => Promise<boolean>
}

export type AtomaClient<
    Entities extends Record<string, Entity>,
    Schema extends AtomaSchema<Entities> = AtomaSchema<Entities>
> = PluginCapableClient & {
    Store: <Name extends keyof Entities & string>(name: Name) => AtomaStore<Entities, Schema, Name>
    History: AtomaHistory
    Devtools: AtomaClientDevtools
}
