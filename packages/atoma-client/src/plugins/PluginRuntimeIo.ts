import { Protocol } from 'atoma-protocol'
import type * as Types from 'atoma-types/core'
import type { RuntimeIo, StoreHandle } from 'atoma-types/runtime'
import type { HandlerChain } from './HandlerChain'
import type { IoContext, QueryResult, ReadContext, ReadRequest } from 'atoma-types/client'

export class PluginRuntimeIo implements RuntimeIo {
    private readonly ioChain: HandlerChain
    private readonly readChain: HandlerChain
    private readonly now: () => number
    private readonly clientId: string

    constructor(args: {
        io: HandlerChain
        read: HandlerChain
        now?: () => number
        clientId: string
    }) {
        this.ioChain = args.io
        this.readChain = args.read
        this.now = args.now ?? (() => Date.now())
        this.clientId = args.clientId
    }

    executeOps: RuntimeIo['executeOps'] = async (input) => {
        const opsWithTrace = Protocol.ops.build.withTraceMeta({
            ops: input.ops
        })
        const meta = Protocol.ops.build.buildRequestMeta({
            now: this.now
        })
        Protocol.ops.validate.assertOutgoingOps({ ops: opsWithTrace, meta })

        const res = await this.ioChain.execute({
            ops: opsWithTrace,
            meta,
            ...(input.signal ? { signal: input.signal } : {})
        }, { clientId: this.clientId } as IoContext)

        try {
            return Protocol.ops.validate.assertOperationResults((res as any).results)
        } catch (error) {
            throw toProtocolValidationError(error, 'Invalid ops response')
        }
    }

    query: RuntimeIo['query'] = async <T extends Types.Entity>(
        handle: StoreHandle<T>,
        query: Types.Query,
        signal?: AbortSignal
    ): Promise<QueryResult> => {
        const req: ReadRequest = {
            storeName: handle.storeName,
            query,
            ...(signal ? { signal } : {})
        }
        const ctx: ReadContext = {
            clientId: this.clientId,
            store: String(handle.storeName)
        }
        return await this.readChain.execute(req, ctx)
    }
}

function toProtocolValidationError(error: unknown, fallbackMessage: string): Error {
    const standard = Protocol.error.wrap(error, {
        code: 'INVALID_RESPONSE',
        message: fallbackMessage,
        kind: 'validation'
    })
    const err = new Error(`[Atoma] ${standard.message}`)
    ;(err as any).error = standard
    return err
}
