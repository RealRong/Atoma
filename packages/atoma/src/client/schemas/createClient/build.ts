import { createClientArgSchema } from '#client/schemas/createClient/args'

export const createClientBuildArgsSchema = createClientArgSchema
    .transform((options: any) => {
        return {
            schema: (options.schema ?? ({} as any)) as any,
            ...(options.dataProcessor ? { dataProcessor: options.dataProcessor as any } : {}),
            backend: options.backend as any,
            ...(Array.isArray(options.plugins) ? { plugins: options.plugins as any } : {})
        } as any
    })

