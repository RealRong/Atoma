export const read = <T>(item: T, field: string): unknown => {
    return (item as Record<string, unknown>)[field]
}
