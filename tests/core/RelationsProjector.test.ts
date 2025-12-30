import { describe, expect, it } from 'vitest'
import type { Entity, StoreKey } from '../../src/core'
import { Core } from '../../src/core'
import { StoreIndexes } from '../../src/core/indexes/StoreIndexes'

type User = Entity & { name: string }
type SlugUser = User & { slug: string }
type Post = Entity & { authorId?: StoreKey; tagIds?: StoreKey[] }
type Comment = Entity & { postId: StoreKey; createdAt: number }
type Profile = Entity & { userId: StoreKey; updatedAt: number }

describe('core relations projector', () => {
    it('belongsTo: 支持 foreignKey 字段/点路径，并支持 primaryKey != id', () => {
        const usersMap = new Map<StoreKey, User>([
            [1, { id: 1, name: 'u1' }],
            [2, { id: 2, name: 'u2' }]
        ])

        const usersBySlugMap = new Map<StoreKey, SlugUser>([
            [10, { id: 10, name: 'u:a', slug: 'a' }],
            [20, { id: 20, name: 'u:b', slug: 'b' }]
        ])

        const items: Array<Post & { meta?: { authorId?: StoreKey } }> = [
            { id: 1, authorId: 1, meta: { authorId: 2 } },
            { id: 2, authorId: 999 },
            { id: 3 }
        ]

        const relations = {
            author: Core.relations.belongsTo<Post, User>('users', { foreignKey: 'authorId' }),
            metaAuthor: Core.relations.belongsTo<Post & { meta?: { authorId?: StoreKey } }, User>('users', { foreignKey: 'meta.authorId' }),
            authorBySlug: Core.relations.belongsTo<Post, SlugUser>('usersBySlug', { foreignKey: () => 'b', primaryKey: 'slug' })
        } as const

        const getStoreMap = (store: string) => {
            if (store === 'users') return usersMap
            if (store === 'usersBySlug') return usersBySlugMap
            return undefined
        }

        const out = Core.relations.projectRelationsBatch(items, {
            author: true,
            metaAuthor: true,
            authorBySlug: true
        }, relations as any, getStoreMap)

        expect((out[0] as any).author?.id).toBe(1)
        expect((out[0] as any).metaAuthor?.id).toBe(2)
        expect((out[1] as any).author).toBeNull()
        expect((out[2] as any).author).toBeNull()
        expect((out[0] as any).authorBySlug?.slug).toBe('b')
    })

    it('hasMany: 按外键 join，并用 applyQuery 处理 orderBy/limit；primaryKey 支持数组', () => {
        const commentsMap = new Map<StoreKey, Comment>([
            [1, { id: 1, postId: 1, createdAt: 2 }],
            [2, { id: 2, postId: 1, createdAt: 1 }],
            [3, { id: 3, postId: 2, createdAt: 9 }]
        ])

        const tagsMap = new Map<StoreKey, any>([
            [11, { id: 11, tagId: 1, label: 't1' }],
            [12, { id: 12, tagId: 2, label: 't2' }],
            [13, { id: 13, tagId: 3, label: 't3' }]
        ])

        const items: Post[] = [
            { id: 1, tagIds: [1, 3] },
            { id: 2, tagIds: [] },
            { id: 3 }
        ]

        const relations = {
            comments: Core.relations.hasMany<Post, Comment>('comments', { foreignKey: 'postId' }),
            tags: Core.relations.hasMany<Post, any>('tags', { primaryKey: (p) => p.tagIds, foreignKey: 'tagId' })
        } as const

        const getStoreMap = (store: string) => {
            if (store === 'comments') return commentsMap
            if (store === 'tags') return tagsMap
            return undefined
        }

        const out = Core.relations.projectRelationsBatch(items, {
            comments: { orderBy: { field: 'createdAt', direction: 'asc' }, limit: 1 },
            tags: true
        }, relations as any, getStoreMap)

        expect((out[0] as any).comments.map((c: any) => c.id)).toEqual([2])
        expect((out[1] as any).comments.map((c: any) => c.id)).toEqual([3])
        expect((out[2] as any).comments).toEqual([])

        expect((out[0] as any).tags.map((t: any) => t.label).sort()).toEqual(['t1', 't3'])
        expect((out[1] as any).tags).toEqual([])
        expect((out[2] as any).tags).toEqual([])
    })

    it('hasMany: 支持传入 { map, indexes }，避免每次扫完整 target store 建桶', () => {
        const commentsMap = new Map<StoreKey, Comment>([
            [1, { id: 1, postId: 1, createdAt: 2 }],
            [2, { id: 2, postId: 1, createdAt: 1 }],
            [3, { id: 3, postId: 2, createdAt: 9 }]
        ])

        const commentsIndexes = new StoreIndexes<Comment>([
            { field: 'postId', type: 'number' }
        ])
        commentsIndexes.applyMapDiff(new Map(), commentsMap)

        const items: Post[] = [
            { id: 1 },
            { id: 2 },
            { id: 3 }
        ]

        const relations = {
            comments: Core.relations.hasMany<Post, Comment>('comments', { foreignKey: 'postId' })
        } as const

        const getStoreMap = (store: string) => {
            if (store === 'comments') {
                return { map: commentsMap, indexes: commentsIndexes }
            }
            return undefined
        }

        const out = Core.relations.projectRelationsBatch(items, { comments: true }, relations as any, getStoreMap)

        expect(((out[0] as any).comments as any[]).map(c => c.id).sort()).toEqual([1, 2])
        expect(((out[1] as any).comments as any[]).map(c => c.id).sort()).toEqual([3])
        expect((out[2] as any).comments).toEqual([])
    })

    it('belongsTo: primaryKey != id 时支持传入 { map, indexes } 做索引查找', () => {
        const usersBySlugMap = new Map<StoreKey, SlugUser>([
            [10, { id: 10, name: 'u:a', slug: 'a' }],
            [20, { id: 20, name: 'u:b', slug: 'b' }]
        ])

        const usersBySlugIndexes = new StoreIndexes<SlugUser>([
            { field: 'slug', type: 'string' }
        ])
        usersBySlugIndexes.applyMapDiff(new Map(), usersBySlugMap)

        const items: Post[] = [
            { id: 1 },
            { id: 2 }
        ]

        const relations = {
            authorBySlug: Core.relations.belongsTo<Post, SlugUser>('usersBySlug', { foreignKey: () => 'b', primaryKey: 'slug' })
        } as const

        const getStoreMap = (store: string) => {
            if (store === 'usersBySlug') {
                return { map: usersBySlugMap, indexes: usersBySlugIndexes }
            }
            return undefined
        }

        const out = Core.relations.projectRelationsBatch(items, { authorBySlug: true }, relations as any, getStoreMap)

        expect((out[0] as any).authorBySlug?.slug).toBe('b')
        expect((out[1] as any).authorBySlug?.slug).toBe('b')
    })

    it('hasOne: join 后按 orderBy 选 1 条；无匹配为 null', () => {
        const profilesMap = new Map<StoreKey, Profile>([
            [1, { id: 1, userId: 1, updatedAt: 10 }],
            [2, { id: 2, userId: 1, updatedAt: 20 }],
            [3, { id: 3, userId: 2, updatedAt: 5 }]
        ])

        const users: User[] = [
            { id: 1, name: 'u1' },
            { id: 2, name: 'u2' },
            { id: 3, name: 'u3' }
        ]

        const relations = {
            profile: Core.relations.hasOne<User, Profile>('profiles', { foreignKey: 'userId', options: { orderBy: { field: 'updatedAt', direction: 'desc' } } })
        } as const

        const getStoreMap = (store: string) => store === 'profiles' ? profilesMap : undefined

        const out = Core.relations.projectRelationsBatch(users, { profile: true }, relations as any, getStoreMap)

        expect((out[0] as any).profile?.id).toBe(2)
        expect((out[1] as any).profile?.id).toBe(3)
        expect((out[2] as any).profile).toBeNull()
    })

    it('variants: 按分支选择对应关系，并正确收集订阅 store tokens', () => {
        type Notice = Entity & { kind: 'user' | 'post' | 'other'; userId?: StoreKey; postId?: StoreKey }

        const usersMap = new Map<StoreKey, User>([
            [1, { id: 1, name: 'u1' }]
        ])
        const postsMap = new Map<StoreKey, Post>([
            [10, { id: 10, authorId: 1 }]
        ])

        const items: Notice[] = [
            { id: 1, kind: 'user', userId: 1 },
            { id: 2, kind: 'post', postId: 10 },
            { id: 3, kind: 'other' }
        ]

        const relations = {
            target: Core.relations.variants<Notice>([
                {
                    when: (n) => n.kind === 'user',
                    relation: Core.relations.belongsTo<Notice, User>('users', { foreignKey: 'userId' })
                },
                {
                    when: (n) => n.kind === 'post',
                    relation: Core.relations.belongsTo<Notice, Post>('posts', { foreignKey: 'postId' })
                }
            ])
        } as const

        const tokens = Core.relations.collectRelationStoreTokens({ target: true }, relations as any).sort()
        expect(tokens).toEqual(['posts', 'users'])

        const getStoreMap = (store: string) => {
            if (store === 'users') return usersMap
            if (store === 'posts') return postsMap
            return undefined
        }

        const out = Core.relations.projectRelationsBatch(items, { target: true }, relations as any, getStoreMap)

        expect((out[0] as any).target?.id).toBe(1)
        expect((out[1] as any).target?.id).toBe(10)
        expect((out[2] as any).target).toBeNull()
    })
})
