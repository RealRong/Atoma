import type { SchemaValidator } from '../../types'

export async function validateWithSchema<T>(item: T, schema?: SchemaValidator<T>): Promise<T> {
    if (!schema) return item

    try {
        if ((schema as any).safeParse) {
            const result = (schema as any).safeParse(item)
            if (!result.success) {
                const error = (result.error || 'Schema validation failed') as any
                throw error instanceof Error ? error : new Error(String(error))
            }
            return result.data as T
        }

        if ((schema as any).parse) {
            return (schema as any).parse(item)
        }

        if ((schema as any).validateSync) {
            return (schema as any).validateSync(item)
        }

        if ((schema as any).validate) {
            return await (schema as any).validate(item)
        }

        if (typeof schema === 'function') {
            return await (schema as any)(item)
        }
    } catch (error) {
        throw error instanceof Error ? error : new Error(String(error))
    }

    return item
}
