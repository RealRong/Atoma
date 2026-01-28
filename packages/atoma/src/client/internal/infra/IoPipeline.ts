import type { Backend } from '#backend'
import type { IoHandler, IoMiddleware, IoRequest, IoResponse } from '#client/types'

export class IoPipeline {
    private readonly storeBackend: Backend['store'] | undefined
    private readonly remoteBackend: Backend['remote'] | undefined
    private readonly ioMiddlewares: Array<IoMiddleware> = []
    private ioExecute: IoHandler

    constructor(backend?: Backend) {
        this.storeBackend = backend?.store
        this.remoteBackend = backend?.remote
        this.ioExecute = this.compose()
    }

    execute = (req: IoRequest): Promise<IoResponse> => {
        return this.ioExecute(req)
    }

    use = (mw: IoMiddleware) => {
        this.ioMiddlewares.push(mw)
        this.ioExecute = this.compose()
        return () => {
            const idx = this.ioMiddlewares.indexOf(mw)
            if (idx >= 0) this.ioMiddlewares.splice(idx, 1)
            this.ioExecute = this.compose()
        }
    }

    private baseExecute = async (req: IoRequest): Promise<IoResponse> => {
        if (req.channel === 'store') {
            if (!this.storeBackend) {
                throw new Error('[Atoma] store backend 未配置（local-only 模式不支持 ctx.transport.store）')
            }
            return await this.storeBackend.opsClient.executeOps({
                ops: req.ops as any,
                meta: req.meta as any,
                ...(req.signal ? { signal: req.signal } : {}),
                ...(req.context ? { context: req.context } : {})
            }) as any
        }
        if (!this.remoteBackend) {
            throw new Error('[Atoma] io: remote backend 未配置（createClient({ backend })）')
        }
        return await this.remoteBackend.opsClient.executeOps({
            ops: req.ops as any,
            meta: req.meta as any,
            ...(req.signal ? { signal: req.signal } : {}),
            ...(req.context ? { context: req.context } : {})
        }) as any
    }

    private compose = () => {
        let handler: IoHandler = this.baseExecute
        for (let i = this.ioMiddlewares.length - 1; i >= 0; i--) {
            handler = this.ioMiddlewares[i]!(handler)
        }
        return handler
    }
}
