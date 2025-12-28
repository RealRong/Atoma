import { Protocol, type Meta, type OpsResponseData } from '#protocol'
import type { ExecuteOpsInput, ExecuteOpsOutput } from '../OpsClient'
import { OpsClient } from '../OpsClient'
import { createOpsHttpTransport } from './transport/opsTransport'
import { fetchWithRetry, type RetryOptions } from './transport/retryPolicy'
import type { HttpInterceptors } from './transport/jsonClient'

export type HttpOpsClientConfig = {
    baseURL: string
    opsPath?: string
    headers?: () => Promise<Record<string, string>> | Record<string, string>
    retry?: RetryOptions
    fetchFn?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    interceptors?: HttpInterceptors<OpsResponseData>
}

export class HttpOpsClient extends OpsClient {
    private readonly baseURL: string
    private readonly opsPath: string
    private readonly fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    private readonly retry?: RetryOptions
    private readonly getHeaders: () => Promise<Record<string, string>>
    private readonly transport: ReturnType<typeof createOpsHttpTransport>

    constructor(config: HttpOpsClientConfig) {
        super()

        this.baseURL = config.baseURL
        this.opsPath = config.opsPath ?? Protocol.http.paths.OPS
        this.fetchFn = config.fetchFn ?? fetch.bind(globalThis)
        this.retry = config.retry

        this.getHeaders = async () => {
            const headers = config.headers
            if (!headers) return {}
            const resolved = headers()
            return resolved instanceof Promise ? await resolved : resolved
        }

        this.transport = createOpsHttpTransport({
            fetchFn: async (input, init) => fetchWithRetry(this.fetchFn, input, init, this.retry),
            getHeaders: this.getHeaders,
            interceptors: config.interceptors
        })
    }

    private normalizeRequestMeta(meta: Meta): Meta {
        const clientTimeMs = (typeof meta.clientTimeMs === 'number' && Number.isFinite(meta.clientTimeMs))
            ? meta.clientTimeMs
            : Date.now()
        return {
            ...meta,
            clientTimeMs
        }
    }

    async executeOps({ ops, meta, context, signal }: ExecuteOpsInput): Promise<ExecuteOpsOutput> {
        const requestMeta = this.normalizeRequestMeta(meta)
        const res = await this.transport.executeOps({
            baseURL: this.baseURL,
            opsPath: this.opsPath,
            ops,
            meta: requestMeta,
            context,
            signal
        })

        return {
            results: res.results as any,
            status: res.response.status
        }
    }
}
