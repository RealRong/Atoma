import { throwError } from '../error'
import type { AtomaServerConfig } from '../config'

export function ensureResourceAllowed<Ctx>(
    resource: string,
    config: AtomaServerConfig<Ctx>,
    meta?: { traceId?: string; requestId?: string }
) {
    const allow = config.authz?.resources?.allow
    const deny = config.authz?.resources?.deny
    if (Array.isArray(deny) && deny.includes(resource)) {
        throwError('ACCESS_DENIED', `Resource access denied: ${resource}`, {
            kind: 'auth',
            resource,
            ...(meta ?? {})
        })
    }
    if (Array.isArray(allow) && allow.length && !allow.includes(resource)) {
        throwError('ACCESS_DENIED', `Resource access denied: ${resource}`, {
            kind: 'auth',
            resource,
            ...(meta ?? {})
        })
    }
}
