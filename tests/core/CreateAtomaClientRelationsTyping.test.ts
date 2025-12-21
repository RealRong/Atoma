import { describe, it, expect } from 'vitest'
import { defineEntities } from '../../src/react'
import type { BaseEntity, Entity, IAdapter, StoreKey, WithRelations } from '../../src/core/types'
import type { ReactStore } from '../../src/react/createReactStore'

type Equal<A, B> =
    (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
        ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2)
            ? true
            : false
        : false

type ExpectType<T extends true> = T

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

type UserEntity = { id: number; name: string; title: string }
type CommentEntity = { id: number; body: string; postId: number; authorId: number }
type PostEntity = BaseEntity & { title: string; body: string; authorId: number }

type Entities = {
    users: UserEntity
    posts: PostEntity
    comments: CommentEntity
}

const client = defineEntities<Entities>().defineStores({
    users: {
        debug: { enabled: true, sample: 1 }
    },
    comments: {
        debug: { enabled: true, sample: 1 },
        relations: {
            author: { type: 'belongsTo', to: 'users', foreignKey: 'authorId' }
        }
    },
    posts: {
        debug: { enabled: true, sample: 1 },
        relations: {
            author: { type: 'belongsTo', to: 'users', foreignKey: 'authorId' },
            comments: { type: 'hasMany', to: 'comments', foreignKey: 'postId' }
        }
    }
}).defineClient({
    defaultAdapterFactory: () => createMockAdapter<any>()
})

const PostsStore = client.Store('posts')
type PostRelations = InferRelations<typeof PostsStore>

type PostWith = WithRelations<PostEntity, PostRelations, {
    author: true
    comments: {
        include: {
            author: true
        }
    }
}>

type _ExpectPostAuthor = ExpectType<Equal<PostWith['author'], UserEntity | null>>
type _ExpectCommentAuthor = ExpectType<Equal<PostWith['comments'][number]['author'], UserEntity | null>>

describe('defineEntities(...).defineStores(...).defineClient relations typing', () => {
    it('runs without runtime assertions (type coverage only)', () => {
        expect(true).toBe(true)
    })
})
