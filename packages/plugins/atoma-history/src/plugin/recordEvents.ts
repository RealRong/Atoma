import type { PluginEvents } from 'atoma-types/client/plugins'
import type { ActionContext, Entity, StoreChange } from 'atoma-types/core'
import type { HistoryManager } from '../manager'

type RecordArgs = Readonly<{
    storeName: string
    changes?: ReadonlyArray<StoreChange<Entity>>
    context: ActionContext
}>

export function bindRecordEvents(args: {
    events: PluginEvents
    manager: HistoryManager
    emitChanged: () => void
}): Array<() => void> {
    const record = ({ storeName, changes, context }: RecordArgs): void => {
        if (!changes?.length) return
        args.manager.record({
            storeName,
            changes,
            context
        })
        args.emitChanged()
    }

    return [
        args.events.on('writeCommitted', ({ storeName, changes, context }) => {
            record({
                storeName: String(storeName),
                changes,
                context
            })
        }),
        args.events.on('changeCommitted', ({ storeName, changes, context }) => {
            record({
                storeName: String(storeName),
                changes,
                context
            })
        })
    ]
}
