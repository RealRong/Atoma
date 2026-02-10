import { z } from 'atoma-shared'

type CreateClientSchemaInput = Readonly<{
    schema?: unknown
    plugins?: unknown[]
}>

type CreateClientBuildArgs = Readonly<{
    schema: unknown
    plugins: unknown[]
}>

export const createClientOptionsSchema = z.object({
    schema: z.unknown().optional(),
    plugins: z.array(z.unknown()).optional(),
})
    .loose()

export const createClientBuildArgsSchema = createClientOptionsSchema
    .transform((options: CreateClientSchemaInput): CreateClientBuildArgs => {
        return {
            schema: options.schema ?? {},
            plugins: Array.isArray(options.plugins) ? options.plugins : []
        }
    })
