import type { PersistRequest } from 'atoma/core'
import type { WriteAction, WriteItem, WriteOptions } from 'atoma/protocol'
import type { OutboxWrite } from '#sync/types'

export function mapTranslatedWriteOpsToOutboxWrites(writeOps: PersistRequest<any>['writeOps']): OutboxWrite[] {
    const out: OutboxWrite[] = []
    for (const w of writeOps) {
        const op: any = w.op
        if (!op || op.kind !== 'write') {
            throw new Error('[atoma-sync] outbox: 仅支持 write op（TranslatedWriteOp.op.kind 必须为 \"write\"）')
        }

        const write: any = op.write
        const resource = String(write?.resource ?? '')
        const action = write?.action as WriteAction
        const options = (write?.options && typeof write.options === 'object') ? (write.options as WriteOptions) : undefined
        const items: WriteItem[] = Array.isArray(write?.items) ? (write.items as WriteItem[]) : []
        if (!resource || !action || items.length !== 1) {
            throw new Error('[atoma-sync] outbox: write op 必须包含 resource/action 且只能有 1 个 item')
        }

        // We intentionally do not support per-write protocol options in the outbox.
        // Keep the sync semantics uniform and controlled by the sync runtime config.
        if (options && Object.keys(options as any).length > 0) {
            throw new Error('[atoma-sync] outbox: 不支持 write.options（请通过 sync 配置控制行为）')
        }

        const item = items[0] as any
        const meta = item?.meta
        if (!meta || typeof meta !== 'object') {
            throw new Error('[atoma-sync] outbox: write item meta 必填（需要 idempotencyKey/clientTimeMs）')
        }
        if (typeof meta.idempotencyKey !== 'string' || !meta.idempotencyKey) {
            throw new Error('[atoma-sync] outbox: write item meta.idempotencyKey 必填')
        }
        if (typeof meta.clientTimeMs !== 'number' || !Number.isFinite(meta.clientTimeMs)) {
            throw new Error('[atoma-sync] outbox: write item meta.clientTimeMs 必填')
        }

        out.push({
            resource,
            action,
            item,
        })
    }
    return out
}
