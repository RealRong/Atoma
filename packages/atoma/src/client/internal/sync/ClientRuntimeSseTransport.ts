import { Observability } from '#observability'

export class ClientRuntimeSseTransport {
    private traceId: string | undefined
    private requestSequencer: ReturnType<typeof Observability.trace.createRequestSequencer> | undefined

    constructor(
        private readonly buildBaseUrl: (args?: { resources?: string[] }) => string
    ) {}

    buildUrl = (args?: { resources?: string[] }) => {
        const base = this.buildBaseUrl(args)

        if (!this.traceId) {
            this.traceId = Observability.trace.createId()
        }
        if (!this.requestSequencer) {
            this.requestSequencer = Observability.trace.createRequestSequencer()
        }

        const requestId = this.requestSequencer.next(this.traceId)
        return withQueryParams(base, { traceId: this.traceId, requestId })
    }
}

function withQueryParams(url: string, params: { traceId: string; requestId: string }): string {
    try {
        const u = new URL(url)
        u.searchParams.set('traceId', params.traceId)
        u.searchParams.set('requestId', params.requestId)
        return u.toString()
    } catch {
        const t = encodeURIComponent(params.traceId)
        const r = encodeURIComponent(params.requestId)
        const join = url.includes('?') ? '&' : '?'
        return `${url}${join}traceId=${t}&requestId=${r}`
    }
}

