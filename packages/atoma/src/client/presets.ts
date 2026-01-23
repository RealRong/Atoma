import type { Entity } from '#core'
import type { CreateClientOptions, AtomaSchema, HttpEndpointOptions, StoreBatchOptions } from './types'
import type { IndexedDbTablesConfig } from './types/options'

export const presets = {
    onlineOnly: <
        const E extends Record<string, Entity>,
        const S extends AtomaSchema<E> = AtomaSchema<E>
    >(args: {
        url: string
        schema?: S
        http?: HttpEndpointOptions
        storeBatch?: StoreBatchOptions
    }): CreateClientOptions<E, S> => {
        return {
            ...(args.schema ? { schema: args.schema } : {}),
            ...(args.http ? { http: args.http } : {}),
            ...(typeof args.storeBatch !== 'undefined' ? { storeBatch: args.storeBatch } : {}),
            store: {
                type: 'http',
                url: args.url
            }
        }
    },

    localOnly: <
        const E extends Record<string, Entity>,
        const S extends AtomaSchema<E> = AtomaSchema<E>
    >(args: {
        schema?: S
        tables: IndexedDbTablesConfig['tables']
        storeBatch?: StoreBatchOptions
    }): CreateClientOptions<E, S> => {
        return {
            ...(args.schema ? { schema: args.schema } : {}),
            ...(typeof args.storeBatch !== 'undefined' ? { storeBatch: args.storeBatch } : {}),
            store: {
                type: 'indexeddb',
                tables: args.tables
            }
        }
    },

    memoryOnly: <
        const E extends Record<string, Entity>,
        const S extends AtomaSchema<E> = AtomaSchema<E>
    >(args?: {
        schema?: S
        seed?: Record<string, any[]>
        storeBatch?: StoreBatchOptions
    }): CreateClientOptions<E, S> => {
        return {
            ...(args?.schema ? { schema: args.schema } : {}),
            ...(typeof args?.storeBatch !== 'undefined' ? { storeBatch: args.storeBatch } : {}),
            store: {
                type: 'memory',
                ...(args?.seed ? { seed: args.seed } : {})
            }
        }
    }
} as const
