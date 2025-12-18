import { describe, it, expect } from 'vitest'
import { createReactStore } from '../../src/react/createReactStore'
import { belongsTo, hasMany } from '../../src/core/relations/builders'
import type { Entity, IAdapter, StoreKey, WithRelations, RelationMap } from '../../src/core/types'
import type { ReactStore } from '../../src/react/createReactStore'

type Equal<A, B> =
    (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
        ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2)
            ? true
            : false
        : false

type ExpectType<T extends true> = T

type IsAny<T> = 0 extends (1 & T) ? true : false
type IsNever<T> = [T] extends [never] ? true : false
type IsUnknown<T> =
    IsAny<T> extends true
        ? false
        : unknown extends T
            ? ([T] extends [unknown] ? true : false)
            : false

type InferRelations<S> = S extends ReactStore<any, infer R> ? R : never

function createMockAdapter<T extends Entity>(): IAdapter<T> {
    return {
        name: 'mock',
        put: async () => { /* noop */ },
        bulkPut: async () => { /* noop */ },
        delete: async () => { /* noop */ },
        bulkDelete: async () => { /* noop */ },
        get: async () => undefined,
        bulkGet: async () => [],
        getAll: async () => []
    }
}

type User = { id: StoreKey; name: string }
type Comment = { id: StoreKey; postId: StoreKey; authorId: StoreKey; body: string }
type Post = { id: StoreKey; authorId: StoreKey; createdAt: number; title: string }

const UsersStore = createReactStore<User>({
    name: 'users',
    adapter: createMockAdapter<User>()
})

const CommentsStore = createReactStore<Comment>({
    name: 'comments',
    adapter: createMockAdapter<Comment>(),
    relations: () => ({
        author: belongsTo(UsersStore, { foreignKey: 'authorId' })
    })
})

const PostsStore = createReactStore<Post>({
    name: 'posts',
    adapter: createMockAdapter<Post>(),
    relations: () => ({
        author: belongsTo(UsersStore, { foreignKey: 'authorId' }),
        comments: hasMany(CommentsStore, { foreignKey: 'postId' })
    })
})

type PostRelations = InferRelations<typeof PostsStore>
type PostWithNested = WithRelations<Post, PostRelations, {
    author: true
    comments: {
        include: {
            author: true
        }
    }
}>

type _ExpectPostAuthor = ExpectType<Equal<PostWithNested['author'], User | null>>
type _ExpectCommentAuthor = ExpectType<Equal<PostWithNested['comments'][number]['author'], User | null>>
type _ExpectPostAuthorNotAny = ExpectType<Equal<IsAny<PostWithNested['author']>, false>>
type _ExpectCommentAuthorNotAny = ExpectType<Equal<IsAny<PostWithNested['comments'][number]['author']>, false>>

// 缺失 relations 元信息：include 仍可写，但字段类型降级为 unknown（不是 never/any）
type PostMissingRelations = WithRelations<Post, {}, { author: true }>
type _ExpectMissingUnknown = ExpectType<Equal<IsUnknown<PostMissingRelations['author']>, true>>
type _ExpectMissingNotNever = ExpectType<Equal<IsNever<PostMissingRelations['author']>, false>>
type _ExpectMissingNotAny = ExpectType<Equal<IsAny<PostMissingRelations['author']>, false>>

// relations 被宽化成 RelationMap<T>（string 索引）时：同样降级为 unknown
type PostWideRelations = WithRelations<Post, RelationMap<Post>, { author: true }>
type _ExpectWideUnknown = ExpectType<Equal<IsUnknown<PostWideRelations['author']>, true>>
type _ExpectWideNotAny = ExpectType<Equal<IsAny<PostWideRelations['author']>, false>>

describe('WithRelations typing', () => {
    it('runs without runtime assertions (type coverage only)', () => {
        expect(true).toBe(true)
    })
})

