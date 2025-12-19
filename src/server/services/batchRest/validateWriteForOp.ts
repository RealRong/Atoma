import { summarizeCreateItem, summarizePatches, summarizeUpdateData } from '../../writeSummary'
import type { AuthzPolicy } from '../../policies/authzPolicy'
import type { AtomaServerConfig, AtomaServerRoute } from '../../config'
import type { BatchOp } from '../../types'
import type { ServerRuntime } from '../../engine/runtime'
import { createGetCurrent } from '../shared/createGetCurrent'

export async function validateWriteForOp<Ctx>(args: {
    config: AtomaServerConfig<Ctx>
    route: AtomaServerRoute
    op: Exclude<BatchOp, { action: 'query' }>
    runtime: ServerRuntime<Ctx>
    authz: AuthzPolicy<Ctx>
}) {
    const { config, route, op, runtime, authz } = args
    const resource = (op as any).resource as string
    const adapter = config.adapter.orm
    const makeGetCurrent = createGetCurrent(adapter, resource)

    if (op.action === 'bulkCreate') {
        const items = Array.isArray((op as any).payload) ? (op as any).payload : []
        await Promise.all(items.map(async (item: any) => {
            const normalized = item?.data
            const summary = summarizeCreateItem(normalized)
            await authz.validateWrite({
                resource,
                op,
                item: normalized,
                changedFields: summary.changedFields,
                ...(Array.isArray(summary.changedPaths) ? { changedPaths: summary.changedPaths } : {}),
                getCurrent: async () => undefined,
                route,
                runtime
            })
        }))
        return
    }

    if (op.action === 'bulkUpdate') {
        const items = Array.isArray((op as any).payload) ? (op as any).payload : []
        await Promise.all(items.map(async (item: any) => {
            const summary = summarizeUpdateData(item?.data)
            await authz.validateWrite({
                resource,
                op,
                item,
                changedFields: summary.changedFields,
                ...(Array.isArray(summary.changedPaths) ? { changedPaths: summary.changedPaths } : {}),
                getCurrent: makeGetCurrent(item?.id),
                route,
                runtime
            })
        }))
        return
    }

    if (op.action === 'bulkPatch') {
        const items = Array.isArray((op as any).payload) ? (op as any).payload : []
        await Promise.all(items.map(async (item: any) => {
            const summary = summarizePatches(item?.patches)
            await authz.validateWrite({
                resource,
                op,
                item,
                changedFields: summary.changedFields,
                ...(Array.isArray(summary.changedPaths) ? { changedPaths: summary.changedPaths } : {}),
                getCurrent: makeGetCurrent(item?.id),
                route,
                runtime
            })
        }))
        return
    }

    if (op.action === 'bulkDelete') {
        const items = Array.isArray((op as any).payload) ? (op as any).payload : []
        await Promise.all(items.map(async (raw: any) => {
            const id = raw?.id
            await authz.validateWrite({
                resource,
                op,
                item: raw,
                changedFields: [],
                getCurrent: makeGetCurrent(id),
                route,
                runtime
            })
        }))
    }
}
