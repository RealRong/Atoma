import { getOpsClient } from 'atoma-types/client/ops'
import { buildWriteOp } from 'atoma-types/protocol-tools'
import type { PluginContext } from 'atoma-types/client/plugins'
import type { WriteEntry } from 'atoma-types/protocol'
import type { PersistRequest, PersistResult } from 'atoma-types/runtime'
import { parseWriteOpResults } from './opsResult'

type Group = {
    action: WriteEntry['action']
    entries: WriteEntry[]
}

function buildOptionsKey(options: WriteEntry['options']): string {
    if (!options || typeof options !== 'object') return ''
    return JSON.stringify(options)
}

function groupWriteEntries(entries: ReadonlyArray<WriteEntry>): Group[] {
    const groupsByKey = new Map<string, Group>()
    const groups: Group[] = []

    for (const entry of entries) {
        const action = entry.action
        const optionsKey = buildOptionsKey(entry.options)
        const key = `${action}::${optionsKey}`

        let group = groupsByKey.get(key)
        if (!group) {
            group = { action, entries: [] }
            groupsByKey.set(key, group)
            groups.push(group)
        }

        group.entries.push(entry)
    }

    return groups
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
        ops,
        ...(req.signal ? { signal: req.signal } : {}),
        meta: {
            v: 1,
            clientTimeMs: req.opContext.timestamp,
            requestId: req.opContext.actionId,
            traceId: req.opContext.actionId
        }
    })

    const results = parseWriteOpResults({
        results: output.results,
        entryGroups: groups.map(group => group.entries)
    })

    return {
        status: 'confirmed',
        ...(results.length ? { results } : {})
    }
}
