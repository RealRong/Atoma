import type { Entity } from '#core'
import type { CreateClientOptions, AtomaSchema } from './types'

type HttpBackendConfig = Extract<NonNullable<CreateClientOptions<any, any>['backend']>, { baseURL: string }>

export const presets = {
    onlineOnly: <
        const E extends Record<string, Entity>,
        const S extends AtomaSchema<E> = AtomaSchema<E>
    >(args: {
        url: string
        schema?: S
        http?: Omit<HttpBackendConfig, 'baseURL'>
    }): CreateClientOptions<E, S> => {
        const backend = args.http
            ? { baseURL: args.url, ...args.http }
            : args.url

        return {
            ...(args.schema ? { schema: args.schema } : {}),
            backend
        }
    },
} as const
