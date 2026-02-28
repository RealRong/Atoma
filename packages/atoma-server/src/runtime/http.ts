import { byteLengthUtf8, isAtomaError, throwError } from '../error'

export type HandleResult = {
    status: number
    body: any
    headers?: Record<string, string>
}

export async function readJsonBodyWithLimit(incoming: any, bodyBytesLimit: number | undefined): Promise<any> {
    const limit = (typeof bodyBytesLimit === 'number' && Number.isFinite(bodyBytesLimit) && bodyBytesLimit > 0)
        ? Math.floor(bodyBytesLimit)
        : undefined

    if (incoming?.body !== undefined) {
        const body = incoming.body
        if (limit) {
            const bytes = estimateJsonBytes(body)
            if (typeof bytes === 'number' && bytes > limit) {
                throwError('PAYLOAD_TOO_LARGE', `Body too large: max ${limit} bytes`, { kind: 'limits', max: limit, actual: bytes })
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
        return parseJsonText(txt)
    }

    if (typeof incoming?.json === 'function') {
        const obj = await readIncomingJson(incoming)
        if (limit) {
            const bytes = estimateJsonBytes(obj)
            if (typeof bytes === 'number' && bytes > limit) {
                throwError('PAYLOAD_TOO_LARGE', `Body too large: max ${limit} bytes`, { kind: 'limits', max: limit, actual: bytes })
            }
        }
        return obj
    }

    return undefined
}

function parseJsonText(text: string): any {
    try {
        return JSON.parse(text)
    } catch (error) {
        throwInvalidPayload(error)
    }
}

async function readIncomingJson(incoming: { json: () => Promise<any> }) {
    try {
        return await incoming.json()
    } catch (error) {
        throwInvalidPayload(error)
    }
}

function estimateJsonBytes(value: unknown): number | undefined {
    try {
        return byteLengthUtf8(JSON.stringify(value ?? ''))
    } catch {
        return undefined
    }
}

function throwInvalidPayload(error: unknown): never {
    if (isAtomaError(error)) throw error
    throwError('INVALID_PAYLOAD', 'Invalid JSON payload', {
        kind: 'validation',
        path: 'body'
    })
}
