import type { DebugEvent } from 'atoma-types/observability'

export type ExportEvent = Readonly<{
    storeName: string
    event: DebugEvent
}>

export type EventExporter = Readonly<{
    publish: (entry: ExportEvent) => void | Promise<void>
    flush?: () => Promise<void>
    dispose?: () => Promise<void> | void
}>
