import type { Entity } from 'atoma-types/core'
import type { IntentCommand } from '../contracts'
import type { Row, WriteCtx } from '../context'
import { toIntentId } from '../internal/row'

export function preflight<T extends Entity>(
    ctx: WriteCtx<T>,
    intents: ReadonlyArray<IntentCommand<T>>
) {
    const seenIds = new Set<string>()
    const rows: Row<T>[] = []

    intents.forEach((intent, index) => {
        const id = toIntentId(intent)
        if (id) {
            if (seenIds.has(id)) {
                throw new Error(`[Atoma] writeMany: duplicate item id in batch (id=${id}, index=${index})`)
            }
            seenIds.add(id)
        }
        rows.push({
            intent,
            intentId: id
        })
    })

    ctx.rows = rows
}
