const readField = <T extends object>(item: T, field: string): unknown => {
    return (item as Record<string, unknown>)[field]
}

export function projectSelect<T extends object>(data: T[], select?: string[]): T[] {
    if (!select || select.length === 0) return data

    return data.map(item => {
        const output: Record<string, unknown> = {}
        for (const field of select) {
            output[field] = readField(item, field)
        }
        return output as T
    })
}
