import type { Entity } from '#core'
import type { AtomaClient, AtomaSchema, CreateClientOptions } from '#client/types'
import { buildAtomaClient } from '#client/internal/factory/build/buildClient'
import { Shared } from '#shared'
import { CreateClientSchemas } from '#client/schemas'

const { parseOrThrow } = Shared.zod

export function createClient<
    const E extends Record<string, Entity>,
    const S extends AtomaSchema<E> = AtomaSchema<E>
>(opt: CreateClientOptions<E, S>): AtomaClient<E, S> {
    const buildArgs = parseOrThrow(CreateClientSchemas.createClientBuildArgsSchema, opt, { prefix: '[Atoma] createClient: ' }) as any
    return buildAtomaClient<E, S>(buildArgs)
}
