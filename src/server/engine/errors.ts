import { errorStatus, toStandardError } from '../error'
import type { AtomaServerConfig, AtomaServerRoute } from '../config'
import type { HandleResult } from '../http/types'

export function createTopLevelErrorFormatter<Ctx>(config: AtomaServerConfig<Ctx>) {
    return (args: { route?: AtomaServerRoute; ctx?: Ctx; requestId?: string; traceId?: string; error: unknown }): HandleResult => {
        if (config.errors?.format) {
            return config.errors.format(args as any)
        }
        const standard = toStandardError(args.error, 'INTERNAL')
        const status = errorStatus(standard)
        return { status, body: { error: standard } }
    }
}

