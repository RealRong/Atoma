import type { Entity } from '#core'
import type { AtomaClient, AtomaSchema, CreateClientOptions } from '#client/types'
import { buildAtomaClient } from '#client/internal/ClientBuilder'
import { zod } from '#shared'
import { CreateClientSchemas } from '#client/schemas'
import type { Backend } from '#backend'
import { createHttpBackend } from '#backend/http/createHttpBackend'

const { parseOrThrow } = zod

export class ClientFactory {
    static create<
        const E extends Record<string, Entity>,
        const S extends AtomaSchema<E> = AtomaSchema<E>
    >(opt: CreateClientOptions<E, S>): AtomaClient<E, S> {
        const buildArgs = parseOrThrow(CreateClientSchemas.createClientBuildArgsSchema, opt, { prefix: '[Atoma] createClient: ' }) as any
        return buildAtomaClient<E, S>({
            ...buildArgs,
            backend: ClientFactory.resolveBackend(buildArgs.backend)
        })
    }

    private static isBackendInstance(value: unknown): value is Backend {
        if (!value || typeof value !== 'object') return false
        const backend = value as any
        const store = backend.store
        return Boolean(store && typeof store === 'object' && store.opsClient && typeof store.opsClient.executeOps === 'function')
    }

    private static resolveBackend(input: CreateClientOptions<any, any>['backend']): Backend | undefined {
        if (typeof input === 'undefined') {
            return undefined
        }

        if (typeof input === 'string') {
            return createHttpBackend({ baseURL: input })
        }

        if (ClientFactory.isBackendInstance(input)) return input

        return createHttpBackend(input as any)
    }
}

export const createClient = ClientFactory.create
