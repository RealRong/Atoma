import { withTraceMeta, assertOutgoingRemoteOps, assertRemoteOpResults, wrapProtocolError } from 'atoma-types/protocol-tools'
import type {
    ExecuteOperationsInput,
    ExecuteOperationsOutput,
    OperationClient,
    RemoteOperationEnvelope,
    RemoteOperationResultEnvelope
} from 'atoma-types/client/ops'
import type { OperationContext } from 'atoma-types/client/plugins'
import { OperationPipeline } from '../plugins/OperationPipeline'

export function createOperationClient(args: {
    operationPipeline: OperationPipeline
    clientId: string
}): OperationClient {
    const executeOperations: OperationClient['executeOperations'] = async (input: ExecuteOperationsInput): Promise<ExecuteOperationsOutput> => {
        const operationsWithTrace = withTraceMeta({
            ops: input.ops
        })
        const meta = input.meta
        assertOutgoingRemoteOps({ ops: operationsWithTrace, meta })

        const req: RemoteOperationEnvelope = {
            ops: operationsWithTrace,
            meta,
            ...(input.signal ? { signal: input.signal } : {})
        }
        const ctx: OperationContext = { clientId: args.clientId }

        const envelope = assertRemoteOpResultEnvelope(await args.operationPipeline.executeOperations({ req, ctx }))

        try {
            return {
                ...(typeof envelope.status === 'number' ? { status: envelope.status } : {}),
                results: assertRemoteOpResults(envelope.results)
            }
        } catch (error) {
            throw toProtocolValidationError(error, 'Invalid ops response')
        }
    }

    return {
        executeOperations
    }
}

function assertRemoteOpResultEnvelope(value: unknown): RemoteOperationResultEnvelope {
    if (!value || typeof value !== 'object') {
        throw new Error('[Atoma] Invalid ops response: envelope missing')
    }

    const candidate = value as { results?: unknown }
    if (!Array.isArray(candidate.results)) {
        throw new Error('[Atoma] Invalid ops response: results must be an array')
    }

    return value as RemoteOperationResultEnvelope
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
