import type { WriteOptions } from '@atoma-js/types/protocol'
import type { QueryResultOne } from '../ports'
import { throwError } from '../../error'
import { prismaCreate } from './writeCreate'

export async function prismaUpsert(
    adapter: any,
    resource: string,
    item: { id: any; data: any; expectedVersion?: number; conflict?: 'cas' | 'lww'; apply?: 'merge' | 'replace' },
    options: WriteOptions = {}
): Promise<QueryResultOne> {
    const conflict: 'cas' | 'lww' = item.conflict === 'lww' ? 'lww' : 'cas'
    const apply: 'merge' | 'replace' = item.apply === 'replace' ? 'replace' : 'merge'
    const id = item?.id
    if (id === undefined) throw new Error('upsert requires id')
    const client = adapter.client
    const updateDelegate = adapter.requireDelegateFromClient(client, resource, 'updateMany')

    const candidate = (item?.data && typeof item.data === 'object' && !Array.isArray(item.data))
        ? { ...(item.data as any), [adapter.idField]: id }
        : { [adapter.idField]: id }

    const ensureCreateVersion = (data: any) => {
        const v = (data as any)?.version
        if (!(typeof v === 'number' && Number.isFinite(v) && v >= 1)) return { ...(data as any), version: 1 }
        return data
    }

    const fetchReturning = async () => {
        if (options.returning === false) return undefined
        return adapter.findOneByKey(
            client,
            resource,
            adapter.idField,
            id,
            adapter.buildSelect(options.select)
        )
    }

    if (conflict === 'cas') {
        const expectedVersion = item.expectedVersion
        const current = await adapter.findOneByKey(client, resource, adapter.idField, id)
        if (!current) {
            return prismaCreate(adapter, resource, ensureCreateVersion(candidate), options)
        }

        const currentVersion = (current as any)?.version
        if (typeof currentVersion !== 'number') {
            throwError('INVALID_WRITE', 'Missing version field', { kind: 'validation', resource })
        }
        if (!(typeof expectedVersion === 'number' && Number.isFinite(expectedVersion))) {
            throwError('CONFLICT', 'CAS upsert requires expectedVersion for existing entity', {
                kind: 'conflict',
                resource,
                id: String(id),
                currentVersion,
                currentValue: current,
                hint: 'rebase'
            })
        }
        if (currentVersion !== expectedVersion) {
            throwError('CONFLICT', 'Version conflict', {
                kind: 'conflict',
                resource,
                currentVersion,
                currentValue: current
            })
        }

        const nextVersion = Math.floor(expectedVersion) + 1
        const next = apply === 'merge'
            ? { ...(current as any), ...(candidate as any), [adapter.idField]: id, version: nextVersion }
            : { ...(candidate as any), [adapter.idField]: id, version: nextVersion, createdAt: (current as any)?.createdAt }

        const updated = await updateDelegate.updateMany!({
            where: {
                [adapter.idField]: id,
                version: Math.floor(expectedVersion)
            },
            data: adapter.toUpdateData(next, adapter.idField)
        })
        if (adapter.readAffectedCount(updated) <= 0) {
            const latest = await adapter.findOneByKey(client, resource, adapter.idField, id)
            if (!latest) {
                throwError('CONFLICT', 'Version conflict', {
                    kind: 'conflict',
                    resource,
                    id: String(id),
                    hint: 'rebase'
                } as any)
            }
            const latestVersion = (latest as any)?.version
            if (typeof latestVersion !== 'number') {
                throwError('INVALID_WRITE', 'Missing version field', { kind: 'validation', resource })
            }
            throwError('CONFLICT', 'Version conflict', {
                kind: 'conflict',
                resource,
                currentVersion: latestVersion,
                currentValue: latest
            })
        }

        return {
            data: await fetchReturning(),
            transactionApplied: adapter.inTransaction
        }
    }

    for (let attempt = 0; attempt < 6; attempt += 1) {
        const current = await adapter.findOneByKey(client, resource, adapter.idField, id)
        if (!current) {
            try {
                return prismaCreate(adapter, resource, ensureCreateVersion(candidate), options)
            } catch (error) {
                if (!adapter.isUniqueViolation(error)) throw error
                continue
            }
        }

        const currentVersion = (current as any)?.version
        if (typeof currentVersion !== 'number' || !Number.isFinite(currentVersion)) {
            throwError('INVALID_WRITE', 'Missing version field', { kind: 'validation', resource })
        }

        const nextVersion = Math.floor(currentVersion) + 1
        const next = apply === 'merge'
            ? { ...(current as any), ...(candidate as any), [adapter.idField]: id, version: nextVersion }
            : { ...(candidate as any), [adapter.idField]: id, version: nextVersion, createdAt: (current as any)?.createdAt }

        const updated = await updateDelegate.updateMany!({
            where: {
                [adapter.idField]: id,
                version: Math.floor(currentVersion)
            },
            data: adapter.toUpdateData(next, adapter.idField)
        })
        if (adapter.readAffectedCount(updated) <= 0) continue

        return {
            data: await fetchReturning(),
            transactionApplied: adapter.inTransaction
        }
    }

    throwError('CONFLICT', 'Version conflict', {
        kind: 'conflict',
        resource,
        id: String(id),
        hint: 'rebase'
    } as any)
}
