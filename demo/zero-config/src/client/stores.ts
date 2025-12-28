import { defineEntities } from 'atoma'

export type UserEntity = {
    id: number
    name: string
    title: string
}

export type CommentEntity = {
    id: number
    body: string
    postId: number
    authorId: number
}

export type PostEntity = {
    id: number
    createdAt: number
    updatedAt: number
    deleted?: boolean
    deletedAt?: number
    version?: number
    _etag?: string
    title: string
    body: string
    authorId: number
}

export type Entities = {
    users: UserEntity
    posts: PostEntity
    comments: CommentEntity
}

// 走 Vite devServer 代理（/api -> http://localhost:3000），避免跨域预检
const API_BASE = '/api'

export const client = defineEntities<Entities>().defineStores({
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
    backend: API_BASE,
    remote: {
        batch: { flushIntervalMs: 5 },
        usePatchForUpdate: true
    },
    sync: true
})

export const Store = client.Store
export const UsersStore = Store('users')
export const CommentsStore = Store('comments')
export const PostsStore = Store('posts')
