import type { WriteOptions } from '@atoma-js/types/protocol'
import type { QueryResultOne } from '../ports'
import { throwError } from '../../error'

export async function prismaDelete(
    adapter: any,
    resource: string,
    whereOrId: any,
    options: WriteOptions = {}
): Promise<QueryResultOne> {
    const baseVersion = (whereOrId && typeof whereOrId === 'object' && !Array.isArray(whereOrId))
        ? (whereOrId as any).baseVersion
        : undefined

    if (typeof baseVersion === 'number' && Number.isFinite(baseVersion)) {
        const id = (whereOrId as any).id
        if (id === undefined) throw new Error('delete requires id')

        const delegate = adapter.requireDelegateFromClient(adapter.client, resource, 'deleteMany')
        const deleted = await delegate.deleteMany!({
            where: {
                [adapter.idField]: id,
                version: Math.floor(baseVersion)
            }
        })
        if (adapter.readAffectedCount(deleted) <= 0) {
            const current = await adapter.findOneByKey(adapter.client, resource, adapter.idField, id)
            if (!current) {
                throwError('NOT_FOUND', 'Not found', { kind: 'not_found', resource, id: String(id) })
            }
            const currentVersion = (current as any).version
            if (typeof currentVersion !== 'number') {
                throwError('INVALID_WRITE', 'Missing version field', { kind: 'validation', resource })
            }
            throwError('CONFLICT', 'Version conflict', {
                kind: 'conflict',
                resource,
                currentVersion,
                currentValue: current
            })
        }
        return { data: undefined, transactionApplied: adapter.inTransaction }
    }

    const delegate = adapter.requireDelegate(resource, 'delete')
    const where = adapter.normalizeWhereOrId(whereOrId)
    const args: any = {
        where,
        select: adapter.buildSelect(options.select)
    }
    const row = await delegate.delete!(args)
    return { data: options.returning === false ? undefined : row, transactionApplied: adapter.inTransaction }
}
