import type { PluginContext } from '@atoma-js/types/client/plugins'
import type { CommandResult, Source, StreamEvent } from '@atoma-js/types/devtools'
import { HUB_TOKEN } from '@atoma-js/types/devtools'
import type { SyncMode } from '@atoma-js/types/sync'
import type { SyncDevtools } from './sync-devtools'
import type { SyncExtension } from '../types'
import { toError } from '../utils/common'

type SyncSourceRuntime = Pick<
    SyncExtension['sync'],
    'start' | 'stop' | 'pull' | 'push' | 'status'
>

export function registerSyncSource(args: {
    ctx: PluginContext
    now: () => number
    devtools: Pick<SyncDevtools, 'snapshot' | 'subscribe'>
    sync: SyncSourceRuntime
}): (() => void) | undefined {
    const hub = args.ctx.services.resolve(HUB_TOKEN)
    if (!hub) return undefined

    const sourceId = `sync.${args.ctx.runtime.id}`
    let revision = 0
    const source: Source = {
        spec: {
            id: sourceId,
            clientId: args.ctx.runtime.id,
            namespace: 'sync',
            title: 'Sync',
            priority: 40,
            panels: [
                { id: 'sync', title: 'Sync', order: 40, renderer: 'stats' },
                { id: 'timeline', title: 'Timeline', order: 80, renderer: 'timeline' },
                { id: 'raw', title: 'Raw', order: 999, renderer: 'raw' }
            ],
            capability: {
                snapshot: true,
                stream: true,
                command: true
            },
            tags: ['plugin'],
            commands: [
                { name: 'sync.start', title: 'Start', argsJson: '{"mode":"full"}' },
                { name: 'sync.stop', title: 'Stop' },
                { name: 'sync.pull', title: 'Pull' },
                { name: 'sync.push', title: 'Push' }
            ]
        },
        snapshot: () => {
            const base = args.devtools.snapshot()
            return {
                version: 1,
                sourceId,
                clientId: args.ctx.runtime.id,
                panelId: 'sync',
                revision,
                timestamp: args.now(),
                data: {
                    ...base,
                    status: args.sync.status()
                }
            }
        },
        subscribe: (emit) => {
            return args.devtools.subscribe((event: unknown) => {
                revision += 1
                const timestamp = args.now()
                const changedEvent: StreamEvent = {
                    version: 1,
                    sourceId,
                    clientId: args.ctx.runtime.id,
                    panelId: 'sync',
                    type: 'data:changed',
                    revision,
                    timestamp
                }
                const timelineEvent: StreamEvent = {
                    version: 1,
                    sourceId,
                    clientId: args.ctx.runtime.id,
                    panelId: 'timeline',
                    type: 'timeline:event',
                    revision,
                    timestamp,
                    payload: event
                }
                emit(changedEvent)
                emit(timelineEvent)
            })
        },
        invoke: async (command): Promise<CommandResult> => {
            try {
                if (command.name === 'sync.start') {
                    const nextMode = typeof command.args?.mode === 'string'
                        ? command.args.mode as SyncMode
                        : undefined
                    args.sync.start(nextMode)
                    return { ok: true }
                }
                if (command.name === 'sync.stop') {
                    args.sync.stop()
                    return { ok: true }
                }
                if (command.name === 'sync.pull') {
                    await args.sync.pull()
                    return { ok: true }
                }
                if (command.name === 'sync.push') {
                    await args.sync.push()
                    return { ok: true }
                }

                return {
                    ok: false,
                    message: `unknown command: ${command.name}`
                }
            } catch (error) {
                const normalized = toError(error)
                return {
                    ok: false,
                    message: normalized.message
                }
            }
        }
    }

    return hub.register(source)
}
