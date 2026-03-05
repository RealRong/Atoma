const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function getValueByPath(obj: unknown, path: string): unknown {
    if (!path.includes('.')) {
        return isRecord(obj) ? obj[path] : undefined
    }

    const segments = path.split('.')
    let current: unknown = obj

    for (const segment of segments) {
        if (!isRecord(current)) return undefined
        current = current[segment]
    }

    return current
}
