import { readJsonBodyWithLimit } from '../http/body'
import type { AtomaServerConfig } from '../config'

export type LimitMeta = {
    traceId?: string
    requestId?: string
}

export type LimitPolicy<Ctx> = {
    readBodyJson: (incoming: any) => Promise<any>
}

export function createLimitPolicy<Ctx>(config: AtomaServerConfig<Ctx>): LimitPolicy<Ctx> {
    return {
        readBodyJson: async (incoming) => {
            return readJsonBodyWithLimit(incoming, config.limits?.bodyBytes)
        }
    }
}
