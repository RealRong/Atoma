import type { AtomaServerConfig, AtomaServerRoute } from '../config'
import type { ServerRuntime } from '../engine/runtime'
import { ensureResourceAllowed } from '../authz/resources'
import { hooksForResource, runAuthzAuthorizeHooks, runAuthzFilterQueryHooks, runAuthzValidateWriteHooks } from '../authz/hooks'

export type AuthzPolicy<Ctx> = {
    ensureResourceAllowed: (resource: string, meta: { traceId?: string; requestId?: string }) => void
    authorize: (args: { action: 'query' | 'write' | 'sync'; resource: string; op: unknown; route: AtomaServerRoute; runtime: ServerRuntime<Ctx> }) => Promise<void>
    filterQuery: (args: { resource: string; params: unknown; op: unknown; route: AtomaServerRoute; runtime: ServerRuntime<Ctx> }) => Promise<Record<string, any>[]>
    validateWrite: (args: {
        resource: string
        op: unknown
        item: unknown
        changedFields: string[]
        changedPaths?: Array<Array<string | number>>
        getCurrent: (fields: string[]) => Promise<unknown | undefined>
        route: AtomaServerRoute
        runtime: ServerRuntime<Ctx>
    }) => Promise<void>
    filterChanges: (args: {
        changes: Array<{ resource: string }>
        route: AtomaServerRoute
        runtime: ServerRuntime<Ctx>
        allowCache?: Map<string, boolean>
    }) => Promise<any[]>
}

export function createAuthzPolicy<Ctx>(config: AtomaServerConfig<Ctx>): AuthzPolicy<Ctx> {
    return {
        ensureResourceAllowed: (resource, meta) => {
            ensureResourceAllowed(resource, config as any, meta)
        },
        authorize: async ({ action, resource, op, route, runtime }) => {
            const hooks = hooksForResource(config, resource).authorize
            await runAuthzAuthorizeHooks(hooks, {
                route,
                ctx: runtime.ctx,
                traceId: runtime.traceId,
                requestId: runtime.requestId,
                action,
                resource,
                op
            })
        },
        filterQuery: async ({ resource, params, op, route, runtime }) => {
            const hooks = hooksForResource(config, resource).filterQuery
            return runAuthzFilterQueryHooks(hooks, {
                route,
                ctx: runtime.ctx,
                traceId: runtime.traceId,
                requestId: runtime.requestId,
                resource,
                params,
                op
            })
        },
        validateWrite: async ({ resource, op, item, changedFields, changedPaths, getCurrent, route, runtime }) => {
            const hooks = hooksForResource(config, resource).validateWrite
            if (!hooks.length) return
            await runAuthzValidateWriteHooks(hooks, {
                route,
                ctx: runtime.ctx,
                traceId: runtime.traceId,
                requestId: runtime.requestId,
                resource,
                op,
                item,
                changedFields,
                ...(Array.isArray(changedPaths) ? { changedPaths } : {}),
                getCurrent
            })
        },
        filterChanges: async ({ changes, route, runtime, allowCache }) => {
            if (!changes.length) return []

            const cache = allowCache ?? new Map<string, boolean>()
            const meta = { ...(runtime.traceId ? { traceId: runtime.traceId } : {}), ...(runtime.requestId ? { requestId: runtime.requestId } : {}) }

            const resources = new Set<string>()
            for (const c of changes) {
                if (c && typeof (c as any).resource === 'string' && (c as any).resource) {
                    resources.add((c as any).resource)
                }
            }

            for (const resource of resources) {
                if (cache.has(resource)) continue
                try {
                    ensureResourceAllowed(resource, config as any, meta)
                } catch {
                    cache.set(resource, false)
                    continue
                }

                try {
                    await runAuthzAuthorizeHooks(hooksForResource(config, resource).authorize, {
                        route,
                        ctx: runtime.ctx,
                        traceId: runtime.traceId,
                        requestId: runtime.requestId,
                        action: 'sync',
                        resource,
                        op: { kind: 'sync:read' }
                    })
                    cache.set(resource, true)
                } catch {
                    cache.set(resource, false)
                }
            }

            return changes.filter(c => {
                const r = (c as any)?.resource
                return typeof r === 'string' && cache.get(r) === true
            })
        }
    }
}

