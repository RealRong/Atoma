import type { Entity } from 'atoma-core'
import type { CreateClientOptions, AtomaSchema } from './types'

export const presets = {
    onlineOnly: <
        const E extends Record<string, Entity>,
        const S extends AtomaSchema<E> = AtomaSchema<E>
    >(args: {
        url: string
        schema?: S
    }): CreateClientOptions<E, S> => {
        return {
            ...(args.schema ? { schema: args.schema } : {}),
            backend: args.url
        }
    },
} as const
