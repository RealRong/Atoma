export function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function isDeepEqual(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true

    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right)) return false
        if (left.length !== right.length) return false
        return left.every((item, index) => isDeepEqual(item, right[index]))
    }

    if (isRecord(left) || isRecord(right)) {
        if (!isRecord(left) || !isRecord(right)) return false
        const leftKeys = Object.keys(left)
        const rightKeys = Object.keys(right)
        if (leftKeys.length !== rightKeys.length) return false
        return leftKeys.every(key => Object.prototype.hasOwnProperty.call(right, key) && isDeepEqual(left[key], right[key]))
    }

    return false
}
