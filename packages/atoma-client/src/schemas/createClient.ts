import { zod } from 'atoma-shared'

const { z } = zod

export const createClientOptionsSchema = z.object({
    schema: z.any().optional(),
    plugins: z.array(z.any()).optional(),
})
    .loose()

export const createClientBuildArgsSchema = createClientOptionsSchema
    .transform((options: any) => {
        return {
            schema: (options.schema ?? ({} as any)) as any,
            ...(options.dataProcessor ? { dataProcessor: options.dataProcessor as any } : {}),
            ...(Array.isArray(options.plugins) ? { plugins: options.plugins as any } : {})
        } as any
    })
