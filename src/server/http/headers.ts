export function getHeader(headers: any, name: string): string | undefined {
    if (!headers) return undefined
    if (typeof headers.get === 'function') {
        const v = headers.get(name)
        return typeof v === 'string' ? v : undefined
    }
    const direct = headers[name]
    if (typeof direct === 'string') return direct
    const lower = headers[name.toLowerCase()]
    if (typeof lower === 'string') return lower
    const key = Object.keys(headers).find(k => k.toLowerCase() === name.toLowerCase())
    if (!key) return undefined
    const v = headers[key]
    return typeof v === 'string' ? v : undefined
}

