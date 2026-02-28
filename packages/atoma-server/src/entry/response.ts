import type { HandleResult } from '../runtime/http'

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
    return Boolean(value && typeof value === 'object' && typeof (value as any)[Symbol.asyncIterator] === 'function')
}

export function serializeErrorForLog(error: unknown) {
    if (error instanceof Error) {
        const anyErr = error as any
        return {
            name: error.name,
            message: error.message,
            stack: error.stack,
            ...(anyErr?.cause !== undefined ? { cause: anyErr.cause } : {})
        }
    }
    return { value: error }
}

function asyncIterableToReadableStream(body: AsyncIterable<unknown>): ReadableStream<Uint8Array> {
    if (typeof ReadableStream !== 'function') {
        throw new Error('ReadableStream is required to stream subscribe responses')
    }

    const encoder = new TextEncoder()
    const iterator = body[Symbol.asyncIterator]()

    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            const { value, done } = await iterator.next()
            if (done) {
                controller.close()
                return
            }
            if (value === undefined) return
            if (value instanceof Uint8Array) {
                controller.enqueue(value)
                return
            }
            controller.enqueue(encoder.encode(typeof value === 'string' ? value : String(value)))
        },
        async cancel() {
            if (typeof iterator.return === 'function') {
                await iterator.return()
            }
        }
    })
}

export function handleResultToResponse(result: HandleResult): Response {
    const headers = new Headers(result.headers ?? {})

    const body = (() => {
        if (result.body === undefined) return null
        if (typeof result.body === 'string') return result.body
        if (isAsyncIterable(result.body)) return asyncIterableToReadableStream(result.body)

        if (!headers.has('content-type')) {
            headers.set('content-type', 'application/json; charset=utf-8')
        }
        return JSON.stringify(result.body)
    })()

    return new Response(body, { status: result.status, headers })
}

export function toIncoming(request: Request) {
    return {
        url: request.url,
        method: request.method,
        headers: request.headers,
        signal: request.signal,
        text: () => request.text(),
        json: () => request.json()
    }
}
