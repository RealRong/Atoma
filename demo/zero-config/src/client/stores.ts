import { HTTPAdapter, belongsTo, hasMany, BaseEntity } from 'atoma'
import { createAtomaStore, setDefaultAdapterFactory } from 'atoma/react'

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

export type Post = BaseEntity & {
    title: string
    body: string
    authorId: number
    author?: User
    comments?: Comment[]
}

// 走 Vite devServer 代理（/api -> http://localhost:3000），避免跨域预检
const API_BASE = '/api'

// 全局默认 HTTP 适配器工厂（针对 demo 资源）
setDefaultAdapterFactory((resourceName: string) =>
    new HTTPAdapter({
        baseURL: API_BASE,
        resourceName,
        batch: true,
        usePatchForUpdate: true,
        offline: { enabled: true, syncOnReconnect: true },
        sync: { enabled: true, mode: 'sse' }
    })
)

export const UsersStore = createAtomaStore<User>({
    name: 'users',
    debug: { enabled: true, sampleRate: 1 }
})

export const CommentsStore = createAtomaStore<Comment>({
    name: 'comments',
    debug: { enabled: true, sampleRate: 1 },
    relations: () => ({
        author: belongsTo(UsersStore, { foreignKey: 'authorId' })
    })
})

export const PostsStore = createAtomaStore<Post>({
    name: 'posts',
    debug: { enabled: true, sampleRate: 1 }
}).withRelations(() => ({
    author: belongsTo(UsersStore, { foreignKey: 'authorId' }),
    comments: hasMany(CommentsStore, { foreignKey: 'postId' })
}))
