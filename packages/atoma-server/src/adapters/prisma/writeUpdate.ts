import type { WriteOptions } from 'atoma-types/protocol'
import type { QueryResultOne } from '../ports'
import { throwError } from '../../error'

export async function prismaUpdate(
    adapter: any,
    resource: string,
    item: { id: any; data: any; baseVersion?: number },
    options: WriteOptions = {}
): Promise<QueryResultOne> {
    if (item?.id === undefined || !item?.data || typeof item.data !== 'object' || Array.isArray(item.data)) {
        throw new Error('update requires id and data object')
    }

    const client = adapter.client
    const delegate = adapter.requireDelegateFromClient(client, resource, 'update')
    const hasBaseVersion = typeof item.baseVersion === 'number' && Number.isFinite(item.baseVersion)

    if (hasBaseVersion) {
        const baseVersion = Math.floor(item.baseVersion as number)
        const updateManyDelegate = adapter.requireDelegateFromClient(client, resource, 'updateMany')

        const next = {
            ...(item.data as any),
            [adapter.idField]: item.id,
            version: baseVersion + 1
        }
        const data = adapter.toUpdateData(next, adapter.idField)
        const updated = await updateManyDelegate.updateMany!({
            where: {
                [adapter.idField]: item.id,
                version: baseVersion
            },
            data
        })

        if (adapter.readAffectedCount(updated) <= 0) {
            const current = await adapter.findOneByKey(client, resource, adapter.idField, item.id)
            if (!current) {
                throwError('NOT_FOUND', 'Not found', { kind: 'not_found', resource, id: String(item.id) })
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

        if (options.returning === false) {
            return { data: undefined, transactionApplied: adapter.inTransaction }
        }
        const row = await adapter.findOneByKey(
            client,
            resource,
            adapter.idField,
            item.id,
            adapter.buildSelect(options.select)
        )
        return { data: row, transactionApplied: adapter.inTransaction }
    }

    const next = { ...(item.data as any), [adapter.idField]: item.id }
    const data = adapter.toUpdateData(next, adapter.idField)
    const row = await delegate.update!({
        where: { [adapter.idField]: item.id },
        data,
        select: adapter.buildSelect(options.select)
    })
    return { data: options.returning === false ? undefined : row, transactionApplied: adapter.inTransaction }
}
