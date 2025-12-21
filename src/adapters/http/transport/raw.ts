import type { ObservabilityContext } from '#observability'
import { Observability } from '#observability'
import { resolveHeaders } from './headers'
import { traceFromContext } from './trace'
import { withAdapterEvents } from './events'

type Trace = ReturnType<typeof traceFromContext>

export type RawRequestArgs = {
    url: string
    endpoint: string
    method: string
    extraHeaders?: Record<string, string>
    body?: unknown
    context?: ObservabilityContext
    trace?: Trace
}

export function createRawHttpTransport(deps: {
    fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    getHeaders: () => Promise<Record<string, string>>
}) {
    const requestJson = async (args: RawRequestArgs): Promise<{ response: Response; json: unknown }> => {
        const trace = args.trace ?? traceFromContext(args.context)
        const ctx = trace.ctx

        const payloadStr = args.body === undefined ? undefined : JSON.stringify(args.body)
        const payloadBytes = (payloadStr !== undefined && ctx?.active)
            ? Observability.utf8.byteLength(payloadStr)
            : (ctx?.active ? 0 : undefined)

        return withAdapterEvents(
            ctx,
            { method: args.method, endpoint: args.endpoint, payloadBytes },
            async () => {
                const headers = await resolveHeaders(deps.getHeaders, trace.headers, args.extraHeaders)
                const init: RequestInit = {
                    method: args.method,
                    headers,
                    ...(payloadStr !== undefined ? { body: payloadStr } : {})
                }

                if (payloadStr !== undefined) {
                    ;(init.headers as Record<string, string>)['Content-Type'] = 'application/json'
                }

                const response = await deps.fetchFn(args.url, init)
                const json = await response.clone().json().catch(() => null)
                return { result: { response, json }, response }
            }
        )
    }

    return { requestJson }
}

