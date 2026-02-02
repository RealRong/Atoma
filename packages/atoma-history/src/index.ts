import { ClientPlugin } from 'atoma-client'
export { HistoryManager } from './HistoryManager'
export type { ActionRecord, ChangeRecord, HistoryChange, PatchMetadata, UndoStack } from './historyTypes'

class DisabledHistoryPlugin extends ClientPlugin {
    readonly id = 'history:disabled'

    setup(): void {
        throw new Error('[atoma-history] 已迁移到新的插件架构，此包尚未完成适配')
    }
}

export function historyPlugin(): ClientPlugin {
    return new DisabledHistoryPlugin()
}
