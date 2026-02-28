export function serializeError(error: unknown): Record<string, unknown> {
    if (error instanceof Error) {
        const value = error as Error & { cause?: unknown }
        return {
            name: value.name,
            message: value.message,
            stack: value.stack,
            ...(value.cause !== undefined ? { cause: value.cause } : {})
        }
    }

    return { value: error }
}
