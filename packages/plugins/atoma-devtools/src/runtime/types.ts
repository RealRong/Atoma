import type { CommandResult, PanelSpec, Snapshot, SourceSpec, StreamEvent } from 'atoma-types/devtools'

export type InspectorPanel = {
    id: string
    title: string
    order: number
    renderer?: PanelSpec['renderer']
}

export type PanelSnapshot = {
    panel: InspectorPanel
    items: Array<{
        sourceId: string
        sourceTitle: string
        source: SourceSpec
        snapshot: Snapshot
    }>
}

export type ClientSnapshot = {
    id: string
    label?: string
    createdAt: number
    updatedAt: number
    sources: SourceSpec[]
    panels: PanelSnapshot[]
}

export type InspectorEvent = {
    type: StreamEvent['type']
    payload: StreamEvent
}

export type ClientInspector = {
    id: string
    label?: string
    snapshot: () => ClientSnapshot
    panel: (panelId: string) => PanelSnapshot | undefined
    subscribe: (fn: (event: InspectorEvent) => void) => () => void
    invoke: (args: { sourceId: string; name: string; args?: Record<string, unknown> }) => Promise<CommandResult>
}

export type GlobalInspector = {
    clients: {
        list: () => Array<{ id: string; label?: string; createdAt: number; lastSeenAt: number }>
        get: (id: string) => ClientInspector
        snapshot: () => { clients: ClientSnapshot[] }
        subscribe: (fn: () => void) => () => void
    }
}
