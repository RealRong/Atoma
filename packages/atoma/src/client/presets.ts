import type { Entity } from '#core'
import type { CreateClientOptions, AtomaSchema } from './types'
import { createHttpBackend } from '#backend'
import type { CreateHttpBackendOptions } from '#backend'

export const presets = {
    onlineOnly: <
        const E extends Record<string, Entity>,
        const S extends AtomaSchema<E> = AtomaSchema<E>
    >(args: {
        url: string
        schema?: S
        http?: Omit<CreateHttpBackendOptions, 'baseURL'>
    }): CreateClientOptions<E, S> => {
        return {
            ...(args.schema ? { schema: args.schema } : {}),
            backend: createHttpBackend({
                baseURL: args.url,
                ...(args.http ? args.http : {})
            })
        }
    },
} as const
