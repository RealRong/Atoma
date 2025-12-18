import { throwError } from '../error'

export function byteLengthUtf8(input: string) {
    if (typeof Buffer !== 'undefined') return Buffer.byteLength(input, 'utf8')
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(input).length
    return input.length
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

