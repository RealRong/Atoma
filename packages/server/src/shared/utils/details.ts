export function toObjectDetails<T extends Record<string, unknown> = Record<string, unknown>>(details: unknown): T | undefined {
    if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined
    return details as T
}
