import { getOpsClient } from 'atoma-types/client/ops'
import { buildWriteOp, assertWriteResultData } from 'atoma-types/protocol-tools'
import type { PluginContext } from 'atoma-types/client/plugins'
import type { WriteEntry, WriteItemResult } from 'atoma-types/protocol'
import type { PersistRequest, PersistResult } from 'atoma-types/runtime'

type Group = {
    action: WriteEntry['action']
    optionsKey: string
    entries: WriteEntry[]
}

function buildOptionsKey(options: unknown): string {
    if (!options || typeof options !== 'object') return ''
    return JSON.stringify(options)
}

function groupWriteEntries(entries: WriteEntry[]): Group[] {
    const groupsByKey = new Map<string, Group>()
    const groups: Group[] = []

    for (const entry of entries) {
        const action = entry.action
        const optionsKey = buildOptionsKey((entry as any).options)
        const key = `${action}::${optionsKey}`

        let group = groupsByKey.get(key)
        if (!group) {
            group = { action, optionsKey, entries: [] }
            groupsByKey.set(key, group)
            groups.push(group)
        }

        group.entries.push(entry)
    }

    return groups
}

function toWriteItemResults(args: {
    groups: Group[]
    opResults: Array<{ ok: boolean; error?: unknown; data?: unknown }>
}): WriteItemResult[] {
    const results: WriteItemResult[] = []

    for (let index = 0; index < args.groups.length; index++) {
        const group = args.groups[index]
        const opResult = args.opResults[index] as any

        if (!opResult) {
            throw new Error('[Atoma] persistViaOps: missing op result')
        }

        if (opResult.ok !== true) {
            for (const entry of group.entries) {
                results.push({
                    entryId: entry.entryId,
                    ok: false,
                    error: (opResult.error && typeof opResult.error === 'object')
                        ? opResult.error
                        : {
                            code: 'WRITE_FAILED',
                            message: '[Atoma] write op failed',
                            kind: 'internal'
                        }
                } as WriteItemResult)
            }
            continue
        }

        const writeData = assertWriteResultData(opResult.data)
        results.push(...writeData.results)
    }

    return results
}

export async function persistViaOps(ctx: PluginContext, req: PersistRequest<any>): Promise<PersistResult<any>> {
    if (!req.writeEntries.length) {
        return { status: 'confirmed' }
    }

    const opsClient = getOpsClient(ctx.capabilities)
    if (!opsClient) {
        throw new Error('[Atoma] persistViaOps: missing client.ops capability')
    }

    const groups = groupWriteEntries(req.writeEntries)
    const ops = groups.map(group => buildWriteOp({
        opId: ctx.runtime.nextOpId(req.storeName, 'w'),
        write: {
            resource: req.storeName,
            entries: group.entries
        }
    }))

    const output = await opsClient.executeOps({
        ops: ops as any,
        ...(req.signal ? { signal: req.signal } : {}),
        meta: {
            v: 1,
            clientTimeMs: req.opContext.timestamp,
            requestId: req.opContext.actionId,
            traceId: req.opContext.actionId
        }
    })

    return {
        status: 'confirmed',
        ...(output.results.length
            ? { results: toWriteItemResults({ groups, opResults: output.results as any }) }
            : {})
    }
}
