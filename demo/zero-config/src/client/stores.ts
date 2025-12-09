import { createSyncStore, HTTPAdapter, belongsTo, hasMany, setDefaultAdapterFactory } from 'atoma'

export type User = {
    id: number
    name: string
    title: string
}

export type Comment = {
    id: number
    body: string
    postId: number
    authorId: number
    author?: User
}

export type Post = {
    id: number
    title: string
    body: string
    authorId: number
    createdAt: number
    author?: User
    comments?: Comment[]
}

const API_BASE = 'http://localhost:3000/api'

// 全局默认 HTTP 适配器工厂（针对 demo 资源）
setDefaultAdapterFactory((resourceName: string) =>
    new HTTPAdapter({
        baseURL: API_BASE,
        resourceName,
        batch: {
            enabled: true,
            endpoint: '/batch',
            // posts 维持更频繁的 flush，用于展示批处理
            flushIntervalMs: resourceName === 'posts' ? 5 : undefined
        }
    })
)

export const UsersStore = createSyncStore<User>({
    name: 'users'
})

export const CommentsStore = createSyncStore<Comment>({
    name: 'comments',
    relations: () => ({
        author: belongsTo(UsersStore, { foreignKey: 'authorId' })
    })
})

export const PostsStore = createSyncStore<Post>({
    name: 'posts'
}).withRelations(() => ({
    author: belongsTo(UsersStore, { foreignKey: 'authorId' }),
    comments: hasMany(CommentsStore, { foreignKey: 'postId' })
}))
