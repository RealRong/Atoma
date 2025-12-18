import type { AtomaServerConfig, AtomaServerRoute } from '../config'

export function hooksForResource<Ctx>(
    config: AtomaServerConfig<Ctx>,
    resource: string
) {
    const globalHooks = config.authz?.hooks
    const per = config.authz?.perResource?.[resource]?.hooks
    return {
        authorize: [...(globalHooks?.authorize ?? []), ...(per?.authorize ?? [])],
        filterQuery: [...(globalHooks?.filterQuery ?? []), ...(per?.filterQuery ?? [])],
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

export async function runAuthzFilterQueryHooks<Ctx>(
    hooks: Array<(args: any) => any> | undefined,
    args: any
): Promise<Record<string, any>[]> {
    if (!hooks || !hooks.length) return []
    const out: Record<string, any>[] = []
    for (const h of hooks) {
        const r = await h(args)
        if (r && typeof r === 'object' && !Array.isArray(r)) out.push(r)
    }
    return out
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

