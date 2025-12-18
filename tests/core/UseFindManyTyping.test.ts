import { describe, it, expect } from 'vitest'
import { createAtomaStore } from '../../src/react/createReactStore'
import { belongsTo, hasMany } from '../../src/core/relations/builders'
import type { Entity, FindManyOptions, IAdapter, StoreKey } from '../../src/core/types'

type Equal<A, B> =
    (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
        ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2)
            ? true
            : false
        : false

type Expect<T extends true> = T

// 简易适配器：仅满足类型检查，测试不会触发实际调用
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
type Comment = { id: StoreKey; postId: StoreKey; authorId: StoreKey }
type Post = { id: StoreKey; authorId: StoreKey }

const UsersStore = createAtomaStore<User>({
    name: 'users',
    adapter: createMockAdapter<User>()
})

const CommentsStore = createAtomaStore<Comment>({
    name: 'comments',
    adapter: createMockAdapter<Comment>()
})

const PostsStore = createAtomaStore<Post>({
    name: 'posts',
    adapter: createMockAdapter<Post>(),
    relations: () => ({
        author: belongsTo(UsersStore, { foreignKey: 'authorId' }),
        comments: hasMany(CommentsStore, { foreignKey: 'postId' })
    })
})

// 编译期断言：include 键应精确为 'author' | 'comments'
type IncludeKeys = keyof NonNullable<Parameters<typeof PostsStore.useFindMany>[0]>['include']
type _ExpectIncludeKeys = Expect<Equal<IncludeKeys, 'author' | 'comments'>>

// 正例：合法 include 类型
const _okArgs: Parameters<typeof PostsStore.useFindMany>[0] = {
    include: { author: true, comments: true }
}

// include 值类型推导应为 boolean | FindManyOptions<TTarget>
type AuthorInclude = NonNullable<Parameters<typeof PostsStore.useFindMany>[0]>['include'] extends { author?: infer V } ? V : never
type _ExpectAuthorInclude = Expect<Equal<AuthorInclude, boolean | FindManyOptions<User>>>
type CommentsInclude = NonNullable<Parameters<typeof PostsStore.useFindMany>[0]>['include'] extends { comments?: infer V } ? V : never
type _ExpectCommentsInclude = Expect<Equal<CommentsInclude, boolean | FindManyOptions<Comment>>>

// 负例：不存在的关系键应报错
// @ts-expect-error
const _badArgs: Parameters<typeof PostsStore.useFindMany>[0] = {
    include: { unknown: true }
}

// 链式 withRelations：显式泛型 + 事后配置 relations 也应推导键名
type PostNoRel = { id: StoreKey; authorId: StoreKey }
const PostsStoreBare = createAtomaStore<PostNoRel>({
    name: 'posts-bare',
    adapter: createMockAdapter<PostNoRel>()
})
const PostsStoreLinked = PostsStoreBare.withRelations(() => ({
    author: belongsTo(UsersStore, { foreignKey: 'authorId' })
}))
type IncludeKeysLinked = keyof NonNullable<Parameters<typeof PostsStoreLinked.useFindMany>[0]>['include']
type _ExpectIncludeKeysLinked = Expect<Equal<IncludeKeysLinked, 'author'>>

describe('useFindMany include typing', () => {
    it('runs without runtime assertions (type coverage only)', () => {
        expect(true).toBe(true)
    })
})
