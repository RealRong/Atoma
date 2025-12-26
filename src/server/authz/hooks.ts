import type { AtomaServerConfig, AtomaServerRoute } from '../config'

export function hooksForResource<Ctx>(
    config: AtomaServerConfig<Ctx>,
    resource: string
) {
    const globalHooks = config.authz?.hooks
    const per = config.authz?.perResource?.[resource]?.hooks
    return {
        authorize: [...(globalHooks?.authorize ?? []), ...(per?.authorize ?? [])],
        validateWrite: [...(globalHooks?.validateWrite ?? []), ...(per?.validateWrite ?? [])]
    }
}

export async function runAuthzAuthorizeHooks<Ctx>(
    hooks: Array<(args: any) => any> | undefined,
    args: any
) {
    if (!hooks || !hooks.length) return
    for (const h of hooks) {
        await h(args)
    }
}

export async function runAuthzValidateWriteHooks<Ctx>(
    hooks: Array<(args: any) => any> | undefined,
    args: any
) {
    if (!hooks || !hooks.length) return
    for (const h of hooks) {
        await h(args)
    }
}
