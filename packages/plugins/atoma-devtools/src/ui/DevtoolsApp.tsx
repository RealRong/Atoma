import { useEffect, useMemo, useRef, useState } from 'react'
import { Devtools } from '../runtime'
import type { ClientInspector, ClientSnapshot, InspectorEvent, PanelSnapshot } from '../runtime'
import { Card } from './components/Card'
import { JsonPre } from './components/JsonPre'
import { Pill } from './components/Pill'
import { TabButtonRow } from './components/TabButtonRow'

type Renderer = 'table' | 'tree' | 'timeline' | 'stats' | 'raw'

function selectPanel(args: {
    snapshot: ClientSnapshot | null
    panelId?: string
}): PanelSnapshot | undefined {
    const { snapshot, panelId } = args
    if (!snapshot) return undefined
    if (!panelId) return snapshot.panels[0]
    return snapshot.panels.find(panel => panel.panel.id === panelId) ?? snapshot.panels[0]
}

function sortPanelSnapshots(left: PanelSnapshot, right: PanelSnapshot): number {
    if (left.panel.order !== right.panel.order) return left.panel.order - right.panel.order
    return left.panel.id.localeCompare(right.panel.id)
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toRows(data: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(data)) {
        return data.filter(item => isObject(item))
    }
    if (isObject(data) && Array.isArray(data.items)) {
        return data.items.filter(item => isObject(item))
    }
    return []
}

function formatCell(value: unknown): string {
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value)
    if (value === undefined) return '-'
    try {
        return JSON.stringify(value)
    } catch {
        return '[unserializable]'
    }
}

function resolveRenderer(args: {
    panel: PanelSnapshot['panel']
    item: PanelSnapshot['items'][number]
}): Renderer {
    const sourcePanel = args.item.source.panels.find(panel => panel.id === args.panel.id)
    return (sourcePanel?.renderer ?? args.panel.renderer ?? 'raw') as Renderer
}

function renderData(args: {
    renderer: Renderer
    snapshot: PanelSnapshot['items'][number]['snapshot']
}) {
    const { renderer, snapshot } = args
    const data = snapshot.data

    if (renderer === 'table') {
        const rows = toRows(data)
        if (rows.length > 0) {
            const columns = Array.from(new Set(rows.flatMap(row => Object.keys(row)))).slice(0, 12)
            return (
                <div className="overflow-x-auto rounded-lg border border-slate-200">
                    <table className="w-full min-w-[440px] text-left text-[11px] text-slate-700">
                        <thead className="bg-slate-50 text-slate-600">
                            <tr>
                                {columns.map((column) => (
                                    <th key={column} className="px-2 py-1 font-semibold">{column}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {rows.slice(0, 120).map((row, rowIndex) => (
                                <tr key={rowIndex} className="border-t border-slate-100">
                                    {columns.map((column) => (
                                        <td key={`${rowIndex}:${column}`} className="max-w-[280px] truncate px-2 py-1 align-top">
                                            {formatCell(row[column])}
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )
        }
    }

    if (renderer === 'stats') {
        if (isObject(data)) {
            const entries = Object.entries(data)
            return (
                <div className="grid grid-cols-1 gap-1 md:grid-cols-2">
                    {entries.map(([key, value]) => (
                        <div key={key} className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[11px]">
                            <span className="font-semibold text-slate-700">{key}: </span>
                            <span className="text-slate-600">{formatCell(value)}</span>
                        </div>
                    ))}
                </div>
            )
        }
    }

    if (renderer === 'timeline') {
        const rows = toRows(data)
        if (rows.length > 0) {
            return (
                <div className="space-y-1.5">
                    {rows.slice(0, 120).map((row, rowIndex) => (
                        <div key={rowIndex} className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] text-slate-700">
                            <div className="mb-1 flex items-center gap-2 text-slate-600">
                                <span>#{rowIndex + 1}</span>
                                <span>{formatCell(row.type)}</span>
                                <span>{formatCell(row.timestamp)}</span>
                            </div>
                            <JsonPre value={row} maxHeight={160} />
                        </div>
                    ))}
                </div>
            )
        }
    }

    if (renderer === 'tree') {
        return <JsonPre value={data} maxHeight={280} />
    }

    return <JsonPre value={snapshot} maxHeight={260} />
}

export default function DevtoolsApp(props: { defaultOpen?: boolean }) {
    const { defaultOpen } = props
    const [open, setOpen] = useState(Boolean(defaultOpen))
    const [clients, setClients] = useState<Array<{ id: string; label?: string; createdAt: number; lastSeenAt: number }>>([])
    const [selectedClientId, setSelectedClientId] = useState<string | undefined>(undefined)
    const [snapshot, setSnapshot] = useState<ClientSnapshot | null>(null)
    const [selectedPanelId, setSelectedPanelId] = useState<string | undefined>(undefined)
    const [commandNameBySource, setCommandNameBySource] = useState<Record<string, string>>({})
    const [commandArgsBySource, setCommandArgsBySource] = useState<Record<string, string>>({})
    const [commandResultBySource, setCommandResultBySource] = useState<Record<string, string>>({})

    const inspectorRef = useRef<ClientInspector | null>(null)
    const unsubClientRef = useRef<null | (() => void)>(null)
    const selectedPanelIdRef = useRef<string | undefined>(undefined)

    const replacePanelSnapshot = (panel: PanelSnapshot | undefined) => {
        if (!panel) return
        setSnapshot((prev) => {
            if (!prev) return prev
            const exists = prev.panels.some(item => item.panel.id === panel.panel.id)
            const panels = exists
                ? prev.panels.map(item => item.panel.id === panel.panel.id ? panel : item)
                : [...prev.panels, panel]
            return {
                ...prev,
                panels: panels.sort(sortPanelSnapshots)
            }
        })
    }

    useEffect(() => {
        if (!open) return

        const global = Devtools.global()
        const refreshClients = () => {
            const list = global.clients.list()
            setClients(list)
            setSelectedClientId((prev) => {
                if (prev && list.some(client => client.id === prev)) return prev
                return list[0]?.id
            })
        }

        refreshClients()
        const unsub = global.clients.subscribe(refreshClients)
        return () => {
            unsub()
        }
    }, [open])

    useEffect(() => {
        unsubClientRef.current?.()
        unsubClientRef.current = null

        if (!open) return
        if (!selectedClientId) {
            inspectorRef.current = null
            setSnapshot(null)
            return
        }

        const global = Devtools.global()
        try {
            const inspector = global.clients.get(selectedClientId)
            inspectorRef.current = inspector
            const refreshAll = () => {
                setSnapshot(inspector.snapshot())
            }
            const refreshCurrentPanel = (panelId?: string) => {
                const currentPanelId = String(panelId ?? selectedPanelIdRef.current ?? '').trim()
                if (!currentPanelId) return
                try {
                    replacePanelSnapshot(inspector.panel(currentPanelId))
                } catch {
                    // ignore
                }
            }

            refreshAll()

            unsubClientRef.current = inspector.subscribe((event: InspectorEvent) => {
                if (event.type === 'source:registered' || event.type === 'source:unregistered') {
                    refreshAll()
                    refreshCurrentPanel()
                    return
                }

                const currentPanelId = selectedPanelIdRef.current
                if (!currentPanelId) return

                const eventPanelId = typeof event.payload.panelId === 'string'
                    ? event.payload.panelId
                    : undefined

                if (!eventPanelId || eventPanelId === currentPanelId || event.type === 'command:result') {
                    refreshCurrentPanel(currentPanelId)
                }
            })
        } catch {
            inspectorRef.current = null
            setSnapshot(null)
        }

        return () => {
            inspectorRef.current = null
            unsubClientRef.current?.()
            unsubClientRef.current = null
        }
    }, [open, selectedClientId])

    useEffect(() => {
        setCommandNameBySource({})
        setCommandArgsBySource({})
        setCommandResultBySource({})
    }, [selectedClientId])

    useEffect(() => {
        selectedPanelIdRef.current = selectedPanelId
        const inspector = inspectorRef.current
        if (!open || !inspector || !selectedPanelId) return
        try {
            replacePanelSnapshot(inspector.panel(selectedPanelId))
        } catch {
            // ignore
        }
    }, [open, selectedPanelId])

    useEffect(() => {
        if (!snapshot?.panels.length) {
            setSelectedPanelId(undefined)
            return
        }

        const exists = selectedPanelId && snapshot.panels.some(panel => panel.panel.id === selectedPanelId)
        if (!exists) {
            setSelectedPanelId(snapshot.panels[0].panel.id)
        }
    }, [selectedPanelId, snapshot])

    const tabs = useMemo(() => {
        return (snapshot?.panels ?? []).map(panel => ({
            id: panel.panel.id,
            title: panel.panel.title
        }))
    }, [snapshot])

    const selectedPanel = useMemo(() => {
        return selectPanel({
            snapshot,
            panelId: selectedPanelId
        })
    }, [selectedPanelId, snapshot])

    const sourceCount = snapshot?.sources.length ?? 0
    const itemCount = selectedPanel?.items.length ?? 0

    const runCommand = async (sourceId: string) => {
        const inspector = inspectorRef.current
        if (!inspector) return

        const name = String(commandNameBySource[sourceId] ?? '').trim()
        if (!name) {
            setCommandResultBySource((prev) => ({
                ...prev,
                [sourceId]: 'command 不能为空'
            }))
            return
        }

        const argsText = String(commandArgsBySource[sourceId] ?? '').trim()
        let args: Record<string, unknown> | undefined
        if (argsText) {
            try {
                const parsed = JSON.parse(argsText)
                if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                    setCommandResultBySource((prev) => ({
                        ...prev,
                        [sourceId]: 'args 必须是 JSON 对象'
                    }))
                    return
                }
                args = parsed as Record<string, unknown>
            } catch (error) {
                const message = error instanceof Error ? error.message : 'JSON 解析失败'
                setCommandResultBySource((prev) => ({
                    ...prev,
                    [sourceId]: `args JSON 错误: ${message}`
                }))
                return
            }
        }

        const result = await inspector.invoke({
            sourceId,
            name,
            ...(args ? { args } : {})
        })

        setCommandResultBySource((prev) => ({
            ...prev,
            [sourceId]: result.ok
                ? `ok${result.message ? `: ${result.message}` : ''}`
                : `error: ${result.message ?? 'invoke failed'}`
        }))

        const currentPanelId = selectedPanelIdRef.current
        if (!currentPanelId) return
        try {
            replacePanelSnapshot(inspector.panel(currentPanelId))
        } catch {
            // ignore
        }
    }

    const applyCommandTemplate = (args: {
        sourceId: string
        name: string
        argsJson?: string
    }) => {
        const { sourceId, name, argsJson } = args
        setCommandNameBySource((prev) => ({
            ...prev,
            [sourceId]: name
        }))
        setCommandArgsBySource((prev) => ({
            ...prev,
            [sourceId]: argsJson ?? ''
        }))
        setCommandResultBySource((prev) => ({
            ...prev,
            [sourceId]: ''
        }))
    }

    const containerClassName = open
        ? 'fixed bottom-4 right-4 z-[9999] h-[70vh] w-[min(920px,calc(100vw-32px))] overflow-hidden rounded-2xl bg-white text-sm text-slate-900 antialiased shadow-[0_0_0_1px_rgba(15,23,42,0.10),0_18px_50px_rgba(15,23,42,0.12)]'
        : 'fixed bottom-4 right-4 z-[9999] w-[min(520px,calc(100vw-32px))] overflow-hidden rounded-2xl bg-white text-sm text-slate-900 antialiased shadow-[0_0_0_1px_rgba(15,23,42,0.10),0_18px_50px_rgba(15,23,42,0.12)]'

    return (
        <div className={containerClassName}>
            <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm">
                <div className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 font-semibold">Atoma DevTools</span>
                    <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-slate-600">
                        {selectedClientId
                            ? `client: ${selectedClientId}${snapshot?.label ? ` (${snapshot.label})` : ''}`
                            : 'client: -'}
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-600">sources: {sourceCount}</span>
                    <button
                        className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-900 hover:bg-slate-50"
                        onClick={() => setOpen((prev) => !prev)}
                    >
                        {open ? '收起' : '展开'}
                    </button>
                </div>
            </div>

            {open && (
                <div className="flex h-[calc(70vh-45px)] min-h-0 flex-col gap-3 p-3">
                    <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-slate-700">Clients</span>
                        <select
                            className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-900"
                            value={selectedClientId ?? ''}
                            onChange={(e) => setSelectedClientId(e.target.value)}
                        >
                            {clients.length === 0 && (
                                <option value="" disabled>暂无 client（先 createClient）</option>
                            )}
                            {clients.map((client) => (
                                <option key={client.id} value={client.id}>
                                    {client.label ? `${client.label} (${client.id})` : client.id}
                                </option>
                            ))}
                        </select>
                    </div>

                    <TabButtonRow
                        tabs={tabs}
                        tab={selectedPanel?.panel.id}
                        setTab={setSelectedPanelId}
                    />

                    <div className="min-h-0 flex-1 overflow-auto pr-1">
                        {!selectedPanel && (
                            <div className="text-xs text-slate-500">暂无面板数据</div>
                        )}

                        {selectedPanel && (
                            <Card
                                title={selectedPanel.panel.title}
                                right={<Pill>items: {itemCount}</Pill>}
                            >
                                {selectedPanel.items.length === 0 && (
                                    <div className="text-xs text-slate-500">当前面板暂无 source 数据</div>
                                )}
                                {selectedPanel.items.map((item) => (
                                    <Card
                                        key={`${selectedPanel.panel.id}:${item.sourceId}`}
                                        title={item.sourceTitle}
                                        right={
                                            <div className="flex items-center gap-2">
                                                <Pill>{item.sourceId}</Pill>
                                                <Pill>rev: {item.snapshot.revision}</Pill>
                                            </div>
                                        }
                                    >
                                        {renderData({
                                            renderer: resolveRenderer({
                                                panel: selectedPanel.panel,
                                                item
                                            }),
                                            snapshot: item.snapshot
                                        })}
                                        {item.source.capability.command && (
                                            <div className="mt-2 space-y-2">
                                                {Array.isArray(item.source.commands) && item.source.commands.length > 0 && (
                                                    <div className="flex flex-wrap gap-1.5">
                                                        {item.source.commands.map((command) => (
                                                            <button
                                                                key={`${item.sourceId}:${command.name}`}
                                                                className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-100"
                                                                onClick={() => {
                                                                    applyCommandTemplate({
                                                                        sourceId: item.sourceId,
                                                                        name: command.name,
                                                                        argsJson: command.argsJson
                                                                    })
                                                                }}
                                                            >
                                                                {command.title || command.name}
                                                            </button>
                                                        ))}
                                                    </div>
                                                )}
                                                <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_1fr_auto]">
                                                    <input
                                                        className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-900"
                                                        placeholder="command，例如 sync.pull"
                                                        value={commandNameBySource[item.sourceId] ?? ''}
                                                        onChange={(e) => {
                                                            const value = e.target.value
                                                            setCommandNameBySource((prev) => ({
                                                                ...prev,
                                                                [item.sourceId]: value
                                                            }))
                                                        }}
                                                    />
                                                    <input
                                                        className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-900"
                                                        placeholder="args JSON，例如 {\"scope\":\"default\"}"
                                                        value={commandArgsBySource[item.sourceId] ?? ''}
                                                        onChange={(e) => {
                                                            const value = e.target.value
                                                            setCommandArgsBySource((prev) => ({
                                                                ...prev,
                                                                [item.sourceId]: value
                                                            }))
                                                        }}
                                                    />
                                                    <button
                                                        className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-900 hover:bg-slate-50"
                                                        onClick={() => void runCommand(item.sourceId)}
                                                    >
                                                        Invoke
                                                    </button>
                                                </div>
                                                {commandResultBySource[item.sourceId] && (
                                                    <div className="text-[11px] text-slate-600">
                                                        {commandResultBySource[item.sourceId]}
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </Card>
                                ))}
                            </Card>
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}
