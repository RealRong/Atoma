import type { Entity } from '#core'
import type { CreateClientOptions, AtomaSchema, HttpEndpointOptions, StoreBatchOptions } from './types'
import type { IndexedDbTablesConfig } from './types/options'

type ResourceNames<E extends Record<string, Entity>> = Array<keyof E & string>

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

    onlineRealtime: <
        const E extends Record<string, Entity>,
        const S extends AtomaSchema<E> = AtomaSchema<E>
    >(args: {
        url: string
        schema?: S
        sse?: string
        resources?: ResourceNames<E>
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
            },
            sync: {
                ...(args.sse ? { sse: args.sse } : { sse: '/sync/subscribe' }),
                ...(args.resources ? { resources: args.resources } : {})
            }
        }
    },

    offlineFirst: <
        const E extends Record<string, Entity>,
        const S extends AtomaSchema<E> = AtomaSchema<E>
    >(args: {
        url: string
        schema?: S
        tables: IndexedDbTablesConfig['tables']
        sse?: string
        resources?: ResourceNames<E>
        http?: HttpEndpointOptions
        storeBatch?: StoreBatchOptions
    }): CreateClientOptions<E, S> => {
        return {
            ...(args.schema ? { schema: args.schema } : {}),
            ...(args.http ? { http: args.http } : {}),
            ...(typeof args.storeBatch !== 'undefined' ? { storeBatch: args.storeBatch } : {}),
            store: {
                type: 'indexeddb',
                tables: args.tables
            },
            sync: {
                url: args.url,
                queue: 'local-first',
                ...(args.sse ? { sse: args.sse } : { sse: '/sync/subscribe' }),
                ...(args.resources ? { resources: args.resources } : {})
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

