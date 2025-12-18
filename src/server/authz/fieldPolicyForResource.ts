import type { AtomaServerConfig } from '../config'

export function fieldPolicyForResource<Ctx>(
    config: AtomaServerConfig<Ctx>,
    resource: string
) {
    return config.authz?.perResource?.[resource]?.fieldPolicy ?? config.authz?.fieldPolicy
}

