import type { HandlerEntry, HandlerMap, HandlerName } from 'atoma-types/client'

type StoredEntry = {
    handler: HandlerEntry['handler']
    priority: number
    order: number
}

export class PluginRegistry {
    private readonly entries = new Map<HandlerName, StoredEntry[]>()
    private order = 0

    register = <K extends HandlerName>(
        name: K,
        handler: HandlerMap[K],
        opts?: { priority?: number }
    ) => {
        const list = this.entries.get(name) ?? []
        const priority = (typeof opts?.priority === 'number' && Number.isFinite(opts.priority)) ? opts.priority : 0
        const entry: StoredEntry = { handler: handler as HandlerEntry['handler'], priority, order: this.order++ }
        list.push(entry)
        this.entries.set(name, list)

        return () => {
            const current = this.entries.get(name)
            if (!current) return
            const next = current.filter(item => item !== entry)
            if (!next.length) this.entries.delete(name)
            else this.entries.set(name, next)
        }
    }

    list = (name: HandlerName): HandlerEntry[] => {
        const current = this.entries.get(name) ?? []
        const sorted = [...current].sort((a, b) => {
            if (a.priority !== b.priority) return a.priority - b.priority
            return a.order - b.order
        })
        return sorted.map(entry => ({ handler: entry.handler, priority: entry.priority }))
    }
}
