import type { Entity, OutboxEnqueuer } from '../../../types'
import type { WriteOp } from '#protocol'
import type { Persister, PersisterPersistArgs, PersisterPersistResult } from '../types'
import { translatePlanToWrites } from './writePlanTranslation'

type OutboxWrite = WriteOp['write']

export class OutboxPersister implements Persister {
    constructor(private readonly sync: OutboxEnqueuer) { }

    buildOutboxWrites<T extends Entity>(args: {
        resource: string
        plan: PersisterPersistArgs<T>['plan']
        operations: PersisterPersistArgs<T>['operations']
        fallbackClientTimeMs: number
    }): OutboxWrite[] {
        const translated = translatePlanToWrites({
            plan: args.plan,
            operations: args.operations,
            fallbackClientTimeMs: args.fallbackClientTimeMs,
            mode: 'outbox'
        })

        const out: OutboxWrite[] = []
        for (const w of translated) {
            if (!w.items.length) continue
            out.push({
                resource: args.resource,
                action: w.action,
                items: w.items,
                ...(w.options ? { options: w.options } : {})
            })
        }
        return out
    }

    async persist<T extends Entity>(args: PersisterPersistArgs<T>): Promise<PersisterPersistResult<T>> {
        /**
         * OutboxPersister 只负责“把本地 mutation 计划翻译成 write items 并写入 outbox”，
         * 不在本地执行网络写入；真正的发送、重试、合并由 sync/outbox 链路处理。
         */
        const resource = args.handle.storeName
        const writes = this.buildOutboxWrites({
            resource,
            plan: args.plan,
            operations: args.operations,
            fallbackClientTimeMs: args.metadata.timestamp
        })
        for (const w of writes) {
            if (!w.items.length) continue
            await this.sync.enqueueWrite(w)
        }
    }
}
