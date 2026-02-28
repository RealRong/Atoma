import type { WriteOptions } from 'atoma-types/protocol'
import type { QueryResultOne } from '../ports'

export async function prismaCreate(
    adapter: any,
    resource: string,
    data: any,
    options: WriteOptions = {}
): Promise<QueryResultOne> {
    const delegate = adapter.requireDelegate(resource, 'create')
    const args: any = {
        data,
        select: adapter.buildSelect(options.select)
    }
    const row = await delegate.create!(args)
    return { data: options.returning === false ? undefined : row, transactionApplied: adapter.inTransaction }
}
