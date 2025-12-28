import { byteLengthUtf8, throwError } from '../error'

export type HandleResult = {
    status: number
    body: any
    headers?: Record<string, string>
}

export async function readJsonBody(incoming: any): Promise<any> {
    if (incoming?.body !== undefined) return incoming.body
    if (typeof incoming?.text === 'function') {
        const txt = await incoming.text()
        if (!txt) return undefined
        return JSON.parse(txt)
    }
    if (typeof incoming?.json === 'function') return incoming.json()
    return undefined
}

export async function readJsonBodyWithLimit(incoming: any, bodyBytesLimit: number | undefined): Promise<any> {
    const limit = (typeof bodyBytesLimit === 'number' && Number.isFinite(bodyBytesLimit) && bodyBytesLimit > 0)
        ? Math.floor(bodyBytesLimit)
        : undefined

    if (incoming?.body !== undefined) {
        const body = incoming.body
        if (limit) {
            try {
                const bytes = byteLengthUtf8(JSON.stringify(body ?? ''))
                if (bytes > limit) {
                    throwError('PAYLOAD_TOO_LARGE', `Body too large: max ${limit} bytes`, { kind: 'limits', max: limit, actual: bytes })
                }
            } catch {
                // ignore size estimation failure
            }
        }
        return body
    }

    if (typeof incoming?.text === 'function') {
        const txt = await incoming.text()
        if (!txt) return undefined
        if (limit) {
            const bytes = byteLengthUtf8(txt)
            if (bytes > limit) {
                throwError('PAYLOAD_TOO_LARGE', `Body too large: max ${limit} bytes`, { kind: 'limits', max: limit, actual: bytes })
            }
        }
        return JSON.parse(txt)
    }

    if (typeof incoming?.json === 'function') {
        const obj = await incoming.json()
        if (limit) {
            try {
                const bytes = byteLengthUtf8(JSON.stringify(obj ?? ''))
                if (bytes > limit) {
                    throwError('PAYLOAD_TOO_LARGE', `Body too large: max ${limit} bytes`, { kind: 'limits', max: limit, actual: bytes })
                }
            } catch {
                // ignore
            }
        }
        return obj
    }

    return undefined
}

export function normalizePath(path: string) {
    return path.endsWith('/') && path !== '/' ? path.slice(0, -1) : path
}

export function stripBasePath(url: string, basePath: string): string | undefined {
    const u = new URL(url, 'http://localhost')
    const pathname = u.pathname
    const base = normalizePath(basePath)
    if (!base || base === '/') return u.pathname + u.search
    if (!pathname.startsWith(base)) return undefined
    const rest = pathname.slice(base.length) || '/'
    return (rest.startsWith('/') ? rest : `/${rest}`) + u.search
}

