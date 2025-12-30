import { describe, expect, it } from 'vitest'
import { Protocol } from '../../src/protocol'

describe('protocol: encodeWriteIntent(upsert)', () => {
    it('encodes upsert intent into write.action=upsert', () => {
        const intent = {
            kind: 'upsert' as const,
            items: [
                {
                    entityId: 'p1',
                    baseVersion: 3,
                    value: { id: 'p1', title: 'hello', version: 3 },
                    meta: { idempotencyKey: 'k1', clientTimeMs: 1 }
                }
            ]
        }

        const encoded = Protocol.ops.encodeWriteIntent(intent as any)
        expect(encoded.action).toBe('upsert')
        expect(encoded.items.length).toBe(1)
        expect((encoded.items[0] as any).entityId).toBe('p1')
        expect((encoded.items[0] as any).baseVersion).toBe(3)
        expect((encoded.items[0] as any).value).toEqual({ id: 'p1', title: 'hello', version: 3 })
        expect((encoded.items[0] as any).meta).toEqual({ idempotencyKey: 'k1', clientTimeMs: 1 })
    })
})

