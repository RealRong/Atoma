import type { ClientPlugin } from 'atoma-client'
export { HistoryManager } from './HistoryManager'
export type { ActionRecord, ChangeRecord, HistoryChange, PatchMetadata, UndoStack } from './historyTypes'

export function historyPlugin(): ClientPlugin {
    return {
        id: 'history:disabled',
        init: () => {
            throw new Error('[atoma-history] 已迁移到新的插件架构，此包尚未完成适配')
        }
    }
}
