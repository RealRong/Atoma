import type { AtomaChange } from '../ports'

export async function appendChangeToModel(args: {
    model: any
    change: Omit<AtomaChange, 'cursor'>
}): Promise<AtomaChange> {
    if (!args.model?.create) {
        throw new Error('Prisma changes model is missing. Define `model atoma_changes` in schema.prisma.')
    }

    const row = await args.model.create({
        data: {
            resource: args.change.resource,
            id: args.change.id,
            kind: args.change.kind,
            serverVersion: args.change.serverVersion,
            changedAt: args.change.changedAt
        }
    })

    return {
        cursor: Number(row.cursor),
        resource: String(row.resource),
        id: String(row.id),
        kind: row.kind,
        serverVersion: Number(row.serverVersion),
        changedAt: Number(row.changedAt)
    }
}

export async function pullChangesByResourceFromModel(args: {
    model: any
    resource: string
    cursor: number
    limit: number
}): Promise<AtomaChange[]> {
    const resource = String(args.resource ?? '').trim()
    if (!resource || !args.model?.findMany) return []

    const cursor = Math.max(0, Math.floor(args.cursor))
    const limit = Math.max(1, Math.floor(args.limit))
    const rows = await args.model.findMany({
        where: {
            resource,
            cursor: { gt: cursor }
        },
        orderBy: { cursor: 'asc' },
        take: limit
    })

    return rows.map((row: any) => ({
        cursor: Number(row.cursor),
        resource: String(row.resource),
        id: String(row.id),
        kind: row.kind,
        serverVersion: Number(row.serverVersion),
        changedAt: Number(row.changedAt)
    }))
}

export async function waitForResourceChangesFromModel(args: {
    model: any
    resources?: string[]
    afterCursorByResource?: Record<string, number>
    timeoutMs: number
}): Promise<Array<{ resource: string; cursor: number }>> {
    const allowList = (args.resources ?? [])
        .map(value => String(value ?? '').trim())
        .filter(Boolean)
    const allow = allowList.length ? new Set(allowList) : null
    const byResource = args.afterCursorByResource ?? {}
    const deadline = Date.now() + Math.max(0, args.timeoutMs)

    while (Date.now() < deadline) {
        if (!args.model?.findMany) return []

        const rows = await args.model.findMany({
            where: allowList.length
                ? { resource: { in: allowList } }
                : undefined,
            orderBy: { cursor: 'desc' },
            take: allowList.length
                ? Math.max(allowList.length * 4, 50)
                : 200
        })

        const seen = new Set<string>()
        const changed: Array<{ resource: string; cursor: number }> = []

        for (const row of rows) {
            const resource = String((row as any)?.resource ?? '').trim()
            if (!resource || seen.has(resource)) continue
            seen.add(resource)
            if (allow && !allow.has(resource)) continue

            const cursor = Number((row as any)?.cursor)
            if (!Number.isFinite(cursor) || cursor <= 0) continue

            const knownCursor = Math.max(0, Math.floor(Number(byResource[resource] ?? 0)))
            if (cursor <= knownCursor) continue
            changed.push({ resource, cursor: Math.floor(cursor) })
        }

        if (changed.length) return changed
        await new Promise(resolve => setTimeout(resolve, 250))
    }

    return []
}
