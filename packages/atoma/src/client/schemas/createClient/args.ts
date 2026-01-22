import { Shared } from '#shared'
import { createClientOptionsSchema } from '#client/schemas/createClient/options'

const { z } = Shared.zod

export const createClientArgSchema = z.preprocess(
    value => (typeof value === 'string'
        ? {
            store: {
                type: 'http' as const,
                url: value
            }
        }
        : value),
    createClientOptionsSchema
)
