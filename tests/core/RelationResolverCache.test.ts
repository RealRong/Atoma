import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RelationResolver } from '../../src/core/relations/RelationResolver'
import { hasMany } from '../../src/core/relations/builders'
import { Entity, IStore, RelationMap } from '../../src/core/types'

interface Comment extends Entity {
    postId: number
    body?: string
}

interface Post extends Entity {
    title: string
    comments?: Comment[]
}

const clearRelationCache = () => {
    const cache = (RelationResolver as any).relationCache as Map<string, Map<string, any[]>>
    cache?.clear()
}

const createCommentsStore = () => {
    return {
        name: 'comments',
        findMany: vi.fn()
    } as unknown as IStore<Comment>
}

describe('RelationResolver 缓存命中只查询缺失键', () => {
    let commentsStore: IStore<Comment>
    let relations: RelationMap<Post>

    beforeEach(() => {
        clearRelationCache()
        commentsStore = createCommentsStore()
        relations = {
            comments: hasMany<Post, Comment>(commentsStore, { foreignKey: 'postId' })
        }
    })

    it('已缓存键不再参与 in 查询，返回值保持合并', async () => {
        ;(commentsStore.findMany as any)
            .mockResolvedValueOnce([{ id: 'c1', postId: 1 }])
            .mockResolvedValueOnce([{ id: 'c2', postId: 2 }])

        const first = await RelationResolver.resolveBatch<Post>(
            [{ id: 1, title: 'P1' }],
            { comments: true },
            relations
        )

        expect(commentsStore.findMany).toHaveBeenCalledTimes(1)
        expect((commentsStore.findMany as any).mock.calls[0][0].where.postId.in).toEqual([1])
        expect(first[0].comments?.[0].id).toBe('c1')

        ;(commentsStore.findMany as any).mockClear()

        const second = await RelationResolver.resolveBatch<Post>(
            [
                { id: 1, title: 'P1' },
                { id: 2, title: 'P2' }
            ],
            { comments: true },
            relations
        )

        expect(commentsStore.findMany).toHaveBeenCalledTimes(1)
        expect((commentsStore.findMany as any).mock.calls[0][0].where.postId.in).toEqual([2])
        expect(second[0].comments?.[0].id).toBe('c1')
        expect(second[1].comments?.[0].id).toBe('c2')
    })
})
