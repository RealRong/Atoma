import { describe, expect, it, vi } from 'vitest'
import {
    disposeReplications,
    pauseStates,
    startStates,
    waitReplicationsInSync
} from './runtime'
import type { ResourceReplication, ResourceStateMap } from '../runtime/contracts'

function createState({
    key,
    marks
}: {
    key: string
    marks: string[]
}): ResourceReplication {
    const stream = {
        start: vi.fn(() => {
            marks.push(`${key}:stream.start`)
        }),
        stop: vi.fn(() => {
            marks.push(`${key}:stream.stop`)
        }),
        dispose: vi.fn(() => {
            marks.push(`${key}:stream.dispose`)
        })
    }
    const replication = {
        start: vi.fn(async () => {
            marks.push(`${key}:replication.start`)
        }),
        pause: vi.fn(async () => {
            marks.push(`${key}:replication.pause`)
        }),
        cancel: vi.fn(async () => {
            marks.push(`${key}:replication.cancel`)
        }),
        awaitInSync: vi.fn(async () => {
            marks.push(`${key}:replication.awaitInSync`)
        })
    } as any

    return {
        resource: {
            resource: key,
            storeName: key,
            collectionName: key,
            schema: {} as any
        },
        replication,
        pullEnabled: true,
        pushEnabled: true,
        stream,
        subscriptions: [
            {
                unsubscribe: () => {
                    marks.push(`${key}:subscription.first`)
                }
            },
            {
                unsubscribe: () => {
                    marks.push(`${key}:subscription.second`)
                }
            }
        ]
    }
}

function createStates(marks: string[]): ResourceStateMap {
    const map: ResourceStateMap = new Map()
    map.set('users', createState({ key: 'users', marks }))
    map.set('posts', createState({ key: 'posts', marks }))
    return map
}

describe('replication/runtime lifecycle', () => {
    it('startStates 和 pauseStates 应触发 replication 与 stream 生命周期', async () => {
        const marks: string[] = []
        const states = createStates(marks)

        await startStates(states)
        await pauseStates(states)

        expect(marks).toEqual([
            'users:replication.start',
            'users:stream.start',
            'posts:replication.start',
            'posts:stream.start',
            'users:stream.stop',
            'users:replication.pause',
            'posts:stream.stop',
            'posts:replication.pause'
        ])
    })

    it('disposeReplications 应按逆序释放订阅并取消 replication', async () => {
        const marks: string[] = []
        const states = createStates(marks)

        await disposeReplications(states)

        expect(marks).toEqual([
            'users:stream.dispose',
            'users:subscription.second',
            'users:subscription.first',
            'users:replication.cancel',
            'posts:stream.dispose',
            'posts:subscription.second',
            'posts:subscription.first',
            'posts:replication.cancel'
        ])
    })

    it('waitReplicationsInSync 应等待所有 replication in-sync', async () => {
        const marks: string[] = []
        const states = createStates(marks)

        await waitReplicationsInSync(Array.from(states.values()))

        expect(marks.includes('users:replication.awaitInSync')).toBe(true)
        expect(marks.includes('posts:replication.awaitInSync')).toBe(true)
    })
})
