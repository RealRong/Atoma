import type { Snapshot, SourceSpec } from 'atoma-types/devtools'
import type { ClientInspector, ClientSnapshot, InspectorPanel, PanelSnapshot } from './types'
import type { ClientEntry } from './registry'

const now = (): number => Date.now()

const buildSnapshotError = (args: {
    source: SourceSpec
    panelId: string
    error: unknown
}): Snapshot => {
    const message = args.error instanceof Error
        ? (args.error.message || 'Unknown error')
        : String(args.error ?? 'Unknown error')

    return {
        version: 1,
        sourceId: args.source.id,
        clientId: args.source.clientId,
        panelId: args.panelId,
        revision: 0,
        timestamp: now(),
        data: {
            error: message
        },
        meta: {
            warnings: ['snapshot:error']
        }
    }
}

const sortPanels = (left: InspectorPanel, right: InspectorPanel): number => {
    if (left.order !== right.order) return left.order - right.order
    return left.id.localeCompare(right.id)
}

const collectPanels = (sources: SourceSpec[]): InspectorPanel[] => {
    const byId = new Map<string, InspectorPanel>()

    for (const source of sources) {
        for (const panel of source.panels) {
            const id = String(panel.id ?? '').trim()
            if (!id) continue

            const existing = byId.get(id)
            const nextOrder = typeof panel.order === 'number' ? panel.order : 500
            if (!existing) {
                byId.set(id, {
                    id,
                    title: panel.title || id,
                    order: nextOrder,
                    ...(panel.renderer ? { renderer: panel.renderer } : {})
                })
                continue
            }

            if (nextOrder < existing.order) {
                existing.order = nextOrder
            }
            if (!existing.renderer && panel.renderer) {
                existing.renderer = panel.renderer
            }
            if (!existing.title && panel.title) {
                existing.title = panel.title
            }
        }
    }

    return Array.from(byId.values()).sort(sortPanels)
}

const includesPanel = (source: SourceSpec, panelId: string): boolean => {
    return source.panels.some(panel => panel.id === panelId)
}

const buildPanelSnapshot = ({
    entry,
    panel,
    sources
}: {
    entry: ClientEntry
    panel: InspectorPanel
    sources: SourceSpec[]
}): PanelSnapshot => {
    const items = sources
        .filter(source => includesPanel(source, panel.id))
        .map(source => {
            let snapshot: Snapshot
            try {
                snapshot = entry.hub.snapshot({
                    sourceId: source.id,
                    query: {
                        panelId: panel.id,
                        limit: 100
                    }
                })
            } catch (error) {
                snapshot = buildSnapshotError({
                    source,
                    panelId: panel.id,
                    error
                })
            }

            return {
                sourceId: source.id,
                sourceTitle: source.title,
                source,
                snapshot
            }
        })
        .sort((left, right) => left.sourceId.localeCompare(right.sourceId))

    return {
        panel,
        items
    }
}

function buildSnapshot(entry: ClientEntry): ClientSnapshot {
    const sources = entry.hub.list({ clientId: entry.id })
    const panels = collectPanels(sources).map(panel => {
        return buildPanelSnapshot({
            entry,
            panel,
            sources
        })
    })

    return {
        id: entry.id,
        label: entry.label,
        createdAt: entry.createdAt,
        updatedAt: now(),
        sources,
        panels
    }
}

function buildPanel(entry: ClientEntry, panelId: string): PanelSnapshot | undefined {
    const sources = entry.hub.list({ clientId: entry.id })
    const panel = collectPanels(sources).find((item) => item.id === panelId)
    if (!panel) return undefined

    return buildPanelSnapshot({
        entry,
        panel,
        sources: sources.filter(source => includesPanel(source, panel.id))
    })
}

export function inspectorForEntry(entry: ClientEntry): ClientInspector {
    const snapshot = (): ClientSnapshot => {
        entry.lastSeenAt = now()
        return buildSnapshot(entry)
    }

    return {
        id: entry.id,
        label: entry.label,
        snapshot,
        panel: (panelId: string) => {
            const normalizedPanelId = String(panelId ?? '').trim()
            if (!normalizedPanelId) return undefined
            entry.lastSeenAt = now()
            return buildPanel(entry, normalizedPanelId)
        },
        subscribe: (fn) => {
            return entry.hub.subscribe({ clientId: entry.id }, (event) => {
                fn({
                    type: event.type,
                    payload: event
                })
            })
        },
        invoke: async (args) => {
            const sourceId = String(args.sourceId ?? '').trim()
            const name = String(args.name ?? '').trim()
            if (!sourceId) return { ok: false, message: 'sourceId required' }
            if (!name) return { ok: false, message: 'name required' }
            return await entry.hub.invoke({
                sourceId,
                name,
                ...(args.args ? { args: args.args } : {})
            })
        }
    }
}
