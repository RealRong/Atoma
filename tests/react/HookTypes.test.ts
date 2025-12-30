import { describe, expect, it } from 'vitest'
import type { BelongsToConfig, CoreStore, HasManyConfig } from '../../src/core'
import { useFindMany, useValue } from '../../src/react'

type IsAny<T> = 0 extends (1 & T) ? true : false

type UserEntity = {
    id: number
    name: string
}

type CommentEntity = {
    id: number
    body: string
    postId: number
    authorId: number
}

type PostEntity = {
    id: number
    title: string
    body: string
    authorId: number
}

type CommentsRelations = {
    author: BelongsToConfig<CommentEntity, UserEntity, {}>
}

type PostsRelations = {
    author: BelongsToConfig<PostEntity, UserEntity, {}>
    comments: HasManyConfig<PostEntity, CommentEntity, CommentsRelations>
}

function typeOnlyAssertions() {
    const store = null as any as CoreStore<PostEntity, PostsRelations>

    const postAuthorOnly = useValue(store, 1, {
        include: {
            author: true
        }
    })

    const post = useValue(store, 1, {
        include: {
            author: true,
            comments: {
                include: { author: true }
            }
        }
    })

    const findMany = useFindMany(store, {
        include: {
            author: true,
            comments: {
                include: { author: true }
            }
        },
        fetchPolicy: 'local'
    })

    const findManyIds = useFindMany(store, {
        select: 'ids',
        fetchPolicy: 'local'
    })

    const _postIsAny: IsAny<typeof post> = false
    const _postsIsAny: IsAny<typeof findMany.data> = false
    const _idsIsAny: IsAny<typeof findManyIds.data> = false

    type PostAuthorOnlyValue = NonNullable<typeof postAuthorOnly>
    type HasComments = 'comments' extends keyof PostAuthorOnlyValue ? true : false
    const _authorOnlyHasComments: HasComments = false

    type PostValue = NonNullable<typeof post>
    const _authorIsAny: IsAny<NonNullable<PostValue['author']>> = false
    const _commentsIsAny: IsAny<PostValue['comments']> = false

    type CommentValue = PostValue['comments'][number]
    const _commentAuthorIsAny: IsAny<NonNullable<CommentValue['author']>> = false

    type IdItem = typeof findManyIds.data[number]
    const _idIsNumber: IdItem extends number ? true : false = true

    void _postIsAny
    void _postsIsAny
    void _idsIsAny
    void _authorOnlyHasComments
    void _authorIsAny
    void _commentsIsAny
    void _commentAuthorIsAny
    void _idIsNumber
}

describe('atoma/react hooks (types)', () => {
    it('useValue/useFindMany: include 返回类型不退化为 any', () => {
        // 仅用于编译期类型断言（不要调用 hooks）
        void typeOnlyAssertions
        expect(true).toBe(true)
    })
})
