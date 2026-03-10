import type { AtomaServerConfig, AtomaServerRoute } from '../config'
import type { HandleResult } from './http'
import { composeEnvelopeError } from '@atoma-js/types/tools'
import { statusOf, toStandard } from '../shared/errors/standardError'

export function createTopLevelErrorFormatter<Ctx>(config: AtomaServerConfig<Ctx>) {
    return (args: { route?: AtomaServerRoute; ctx?: Ctx; requestId?: string; traceId?: string; error: unknown }): HandleResult => {
        if (config.errors?.format) {
            return config.errors.format(args as any)
        }
        const standard = toStandard(args.error, 'INTERNAL')
        const status = statusOf(standard)
        const meta = {
            v: 1,
            ...(args.traceId ? { traceId: args.traceId } : {}),
            ...(args.requestId ? { requestId: args.requestId } : {}),
            serverTimeMs: Date.now()
        }
        return { status, body: composeEnvelopeError(standard, meta) }
    }
}
