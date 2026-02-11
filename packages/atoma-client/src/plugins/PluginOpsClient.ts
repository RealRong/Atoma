import { withTraceMeta, assertOutgoingRemoteOps, assertRemoteOpResults, wrapProtocolError } from 'atoma-types/protocol-tools'
import type { ExecuteOpsInput, ExecuteOpsOutput, OpsClientLike, RemoteOpEnvelope, RemoteOpResultEnvelope } from 'atoma-types/client/ops'
import type { OpsContext } from 'atoma-types/client/plugins'
import { markTerminalResult } from './HandlerChain'
import { PluginRegistry } from './PluginRegistry'

export class PluginOpsClient implements OpsClientLike {
    private readonly pluginRegistry: PluginRegistry
    private readonly clientId: string

    constructor(args: {
        pluginRegistry: PluginRegistry
        clientId: string
    }) {
        this.pluginRegistry = args.pluginRegistry
        this.clientId = args.clientId
    }

    executeOps = async (input: ExecuteOpsInput): Promise<ExecuteOpsOutput> => {
        const opsWithTrace = withTraceMeta({
            ops: input.ops
        })
        const meta = input.meta
        assertOutgoingRemoteOps({ ops: opsWithTrace, meta })

        const req: RemoteOpEnvelope = {
            ops: opsWithTrace,
            meta,
            ...(input.signal ? { signal: input.signal } : {})
        }
        const ctx: OpsContext = { clientId: this.clientId }

        const envelope = assertRemoteOpResultEnvelope(await this.pluginRegistry.execute({
            name: 'ops',
            req,
            ctx,
            terminal: () => markTerminalResult({ results: [] })
        }))

        try {
            return {
                ...(typeof envelope.status === 'number' ? { status: envelope.status } : {}),
                results: assertRemoteOpResults(envelope.results)
            }
        } catch (error) {
            throw toProtocolValidationError(error, 'Invalid ops response')
        }
    }
}

function assertRemoteOpResultEnvelope(value: unknown): RemoteOpResultEnvelope {
    if (!value || typeof value !== 'object') {
        throw new Error('[Atoma] Invalid ops response: envelope missing')
    }

    const candidate = value as { results?: unknown }
    if (!Array.isArray(candidate.results)) {
        throw new Error('[Atoma] Invalid ops response: results must be an array')
    }

    return value as RemoteOpResultEnvelope
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
