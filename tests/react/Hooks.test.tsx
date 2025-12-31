/* @vitest-environment jsdom */
import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { createStore as createJotaiStore } from 'jotai/vanilla'
import { Core } from '../../src/core'
import { OpsDataSource } from '../../src/datasources'
import { MemoryOpsClient } from '../../src/backend/local/MemoryOpsClient'
import { useAll, useValue } from '../../src/react'

type Post = {
    id: number
    title: string
    createdAt: number
    updatedAt: number
}

afterEach(() => {
    cleanup()
})

function createPostsStore() {
    return Core.store.createStore<Post>({
        name: 'posts',
        dataSource: new OpsDataSource<Post>({
            opsClient: new MemoryOpsClient(),
            resourceName: 'posts',
            batch: false
        }),
        store: createJotaiStore()
    })
}

describe('atoma/react hooks (pure functions)', () => {
    it('useAll: 订阅集合并随 addOne 更新', async () => {
        const store = createPostsStore()

        function App() {
            const all = useAll(store)
            return <div data-testid="count">{String(all.length)}</div>
        }

        render(<App />)
        expect(screen.getByTestId('count').textContent).toBe('0')

        await act(async () => {
            await store.addOne({ title: 'hello' } as any)
        })

        expect(screen.getByTestId('count').textContent).toBe('1')
    })

    it('useValue: 订阅单条记录', async () => {
        const store = createPostsStore()

        function App(props: { id?: number }) {
            const item = useValue(store, props.id)
            return <div data-testid="title">{item?.title ?? ''}</div>
        }

        const view = render(<App />)
        expect(screen.getByTestId('title').textContent).toBe('')

        let created: any
        await act(async () => {
            created = await store.addOne({ title: 'hello' } as any)
        })

        view.rerender(<App id={created.id} />)
        expect(screen.getByTestId('title').textContent).toBe('hello')
    })
})
