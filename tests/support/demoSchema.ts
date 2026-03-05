import type { Entity, FilterExpr } from '@atoma-js/types/core'
import type { AtomaSchema } from '@atoma-js/types/client'

export type DemoUser = Entity & {
    id: string
    name: string
    age: number
    region: 'EU' | 'APAC' | 'CN' | 'US'
    version?: number
}

export type DemoPost = Entity & {
    id: string
    title: string
    authorId: string
    version?: number
}

export type DemoComment = Entity & {
    id: string
    postId: string
    content: string
    version?: number
}

export type DemoEntities = {
    users: DemoUser
    posts: DemoPost
    comments: DemoComment
}

export type DemoSchema = AtomaSchema<DemoEntities>

export const demoSchema: DemoSchema = {
    users: {
        indexes: [
            { field: 'region', type: 'string' },
            { field: 'age', type: 'number' }
        ],
        relations: {
            posts: { type: 'hasMany', to: 'posts', foreignKey: 'authorId' }
        }
    },
    posts: {
        indexes: [
            { field: 'authorId', type: 'string' }
        ],
        relations: {
            author: { type: 'belongsTo', to: 'users', foreignKey: 'authorId' },
            comments: { type: 'hasMany', to: 'comments', foreignKey: 'postId' }
        }
    },
    comments: {
        indexes: [
            { field: 'postId', type: 'string' }
        ],
        relations: {
            post: { type: 'belongsTo', to: 'posts', foreignKey: 'postId' }
        }
    }
}

export type DemoSeed = {
    users: DemoUser[]
    posts: DemoPost[]
    comments: DemoComment[]
}

export function createDemoSeed(): DemoSeed {
    return {
        users: [
            { id: 'u1', name: 'Ada', age: 27, region: 'EU', version: 1 },
            { id: 'u2', name: 'Bao', age: 34, region: 'APAC', version: 1 },
            { id: 'u3', name: 'Cai', age: 22, region: 'CN', version: 1 },
            { id: 'u4', name: 'Drew', age: 41, region: 'US', version: 1 }
        ],
        posts: [
            { id: 'p1', title: 'Hello Atoma', authorId: 'u1', version: 1 },
            { id: 'p2', title: 'Offline First', authorId: 'u2', version: 1 },
            { id: 'p3', title: 'Local + Sync', authorId: 'u1', version: 1 }
        ],
        comments: [
            { id: 'c1', postId: 'p1', content: 'Nice!', version: 1 },
            { id: 'c2', postId: 'p2', content: 'Great read.', version: 1 },
            { id: 'c3', postId: 'p1', content: 'More details please.', version: 1 }
        ]
    }
}

export function createUserFilterByRegionAndMinAge(args: {
    region?: DemoUser['region']
    minAge?: number
}): FilterExpr<DemoUser> | undefined {
    const conditions: FilterExpr<DemoUser>[] = []
    if (args.region) {
        conditions.push({ op: 'eq', field: 'region', value: args.region })
    }
    if (typeof args.minAge === 'number') {
        conditions.push({ op: 'gte', field: 'age', value: args.minAge })
    }
    if (!conditions.length) return undefined
    return conditions.length === 1 ? conditions[0] : { op: 'and', args: conditions }
}
