import { errorStatus, toStandardError } from '../error'
import type { AtomaServerConfig, AtomaServerRoute } from '../config'
import type { HandleResult } from './http'
import { Protocol } from 'atoma/protocol'

export function createTopLevelErrorFormatter<Ctx>(config: AtomaServerConfig<Ctx>) {
    return (args: { route?: AtomaServerRoute; ctx?: Ctx; requestId?: string; traceId?: string; error: unknown }): HandleResult => {
        if (config.errors?.format) {
            return config.errors.format(args as any)
        }
        const standard = toStandardError(args.error, 'INTERNAL')
        const status = errorStatus(standard)
        const meta = {
            v: 1,
            ...(args.traceId ? { traceId: args.traceId } : {}),
            ...(args.requestId ? { requestId: args.requestId } : {}),
            serverTimeMs: Date.now()
        }
        return { status, body: Protocol.ops.compose.error(standard, meta) }
    }
}

