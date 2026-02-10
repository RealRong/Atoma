import { withTraceMeta, buildRequestMeta, assertOutgoingOps, assertOperationResults, wrapProtocolError } from 'atoma-types/protocol-tools'
import type { Entity, Query } from 'atoma-types/core'
import type { Io, StoreHandle } from 'atoma-types/runtime'
import type { IoContext, PluginReadResult, ReadContext, ReadRequest } from 'atoma-types/client/plugins'
import type { OperationEnvelope, ResultEnvelope } from 'atoma-types/client/ops'
import type { HandlerChain } from './HandlerChain'

export class PluginRuntimeIo implements Io {
    private readonly ioChain: HandlerChain<'io'>
    private readonly readChain: HandlerChain<'read'>
    private readonly now: () => number
    private readonly clientId: string

    constructor(args: {
        io: HandlerChain<'io'>
        read: HandlerChain<'read'>
        now?: () => number
        clientId: string
    }) {
        this.ioChain = args.io
        this.readChain = args.read
        this.now = args.now ?? (() => Date.now())
        this.clientId = args.clientId
    }

    executeOps: Io['executeOps'] = async (input) => {
        const opsWithTrace = withTraceMeta({
            ops: input.ops
        })
        const meta = buildRequestMeta({
            now: this.now
        })
        assertOutgoingOps({ ops: opsWithTrace, meta })

        const req: OperationEnvelope = {
            ops: opsWithTrace,
            meta,
            ...(input.signal ? { signal: input.signal } : {})
        }
        const ctx: IoContext = { clientId: this.clientId }

        const envelope = assertResultEnvelope(await this.ioChain.execute(req, ctx))

        try {
            return assertOperationResults(envelope.results)
        } catch (error) {
            throw toProtocolValidationError(error, 'Invalid ops response')
        }
    }

    query: Io['query'] = async <T extends Entity>(
        handle: StoreHandle<T>,
        query: Query,
        signal?: AbortSignal
    ): Promise<PluginReadResult> => {
        const req: ReadRequest = {
            storeName: handle.storeName,
            query,
            ...(signal ? { signal } : {})
        }
        const ctx: ReadContext = {
            clientId: this.clientId,
            storeName: String(handle.storeName)
        }
        return await this.readChain.execute(req, ctx)
    }
}

function assertResultEnvelope(value: unknown): ResultEnvelope {
    if (!value || typeof value !== 'object') {
        throw new Error('[Atoma] Invalid ops response: envelope missing')
    }

    const candidate = value as { results?: unknown }
    if (!Array.isArray(candidate.results)) {
        throw new Error('[Atoma] Invalid ops response: results must be an array')
    }

    return value as ResultEnvelope
}

function toProtocolValidationError(error: unknown, fallbackMessage: string): Error {
    const standard = wrapProtocolError(error, {
        code: 'INVALID_RESPONSE',
        message: fallbackMessage,
        kind: 'validation'
    })
    const err = new Error(`[Atoma] ${standard.message}`)
    const enhanced = err as Error & { error?: unknown }
    enhanced.error = standard
    return err
}
