import type { CommandSpec, Source, StreamEvent } from '@atoma-js/types/devtools'
import type { HistoryManager } from '../manager'

type SourceRuntime = Readonly<{
    spec: Source['spec']
    snapshot: NonNullable<Source['snapshot']>
    subscribe: NonNullable<Source['subscribe']>
    emitChanged: () => void
}>

const buildSnapshot = (manager: HistoryManager) => {
    return {
        scopes: manager.listScopes().map(scope => ({
            scope,
            canUndo: manager.canUndo(scope),
            canRedo: manager.canRedo(scope)
        }))
    }
}

export function createSource(args: {
    clientId: string
    now: () => number
    manager: HistoryManager
    commands: CommandSpec[]
}): SourceRuntime {
    const sourceId = `history.${args.clientId}`
    let revision = 0
    const subscribers = new Set<(event: StreamEvent) => void>()

    const emitChanged = () => {
        revision += 1
        const event: StreamEvent = {
            version: 1,
            sourceId,
            clientId: args.clientId,
            panelId: 'history',
            type: 'data:changed',
            revision,
            timestamp: args.now()
        }
        for (const subscriber of subscribers) {
            try {
                subscriber(event)
            } catch {
                // ignore
            }
        }
    }

    return {
        spec: {
            id: sourceId,
            clientId: args.clientId,
            namespace: 'history',
            title: 'History',
            priority: 50,
            panels: [
                { id: 'history', title: 'History', order: 50, renderer: 'stats' },
                { id: 'raw', title: 'Raw', order: 999, renderer: 'raw' }
            ],
            capability: {
                snapshot: true,
                stream: true,
                command: true
            },
            tags: ['plugin'],
            commands: args.commands
        },
        snapshot: () => {
            return {
                version: 1,
                sourceId,
                clientId: args.clientId,
                panelId: 'history',
                revision,
                timestamp: args.now(),
                data: buildSnapshot(args.manager)
            }
        },
        subscribe: (fn) => {
            subscribers.add(fn)
            return () => {
                subscribers.delete(fn)
            }
        },
        emitChanged
    }
}
