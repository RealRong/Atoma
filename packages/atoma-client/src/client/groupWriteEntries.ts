import type { WriteEntry } from 'atoma-types/protocol'

export type EntryGroup = {
    entries: WriteEntry[]
}

function optionsKey(options: WriteEntry['options']): string {
    if (!options || typeof options !== 'object') return ''
    return JSON.stringify(options)
}

export function groupWriteEntries(entries: ReadonlyArray<WriteEntry>): EntryGroup[] {
    const groupsByKey = new Map<string, EntryGroup>()
    const groups: EntryGroup[] = []

    for (const entry of entries) {
        const key = `${entry.action}::${optionsKey(entry.options)}`
        const existing = groupsByKey.get(key)
        if (existing) {
            existing.entries.push(entry)
            continue
        }

        const group: EntryGroup = {
            entries: [entry]
        }
        groupsByKey.set(key, group)
        groups.push(group)
    }

    return groups
}
