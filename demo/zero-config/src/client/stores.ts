import { createSyncStore, HTTPAdapter, belongsTo, hasMany } from 'atoma'

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

export const UsersStore = createSyncStore<User>({
    name: 'users',
    adapter: new HTTPAdapter<User>({
        baseURL: API_BASE,
        resourceName: 'users',
        batch: { enabled: true, endpoint: '/batch' }
    })
})

export const CommentsStore = createSyncStore({
    name: 'comments',
    adapter: new HTTPAdapter<Comment>({
        baseURL: API_BASE,
        resourceName: 'comments',
        batch: { enabled: true, endpoint: '/batch' }
    }),
    relations: () => ({
        author: belongsTo(UsersStore, { foreignKey: 'authorId' })
    })
})

export const PostsStore = createSyncStore<Post>({
    name: 'posts',
    adapter: new HTTPAdapter<Post>({
        baseURL: API_BASE,
        resourceName: 'posts',
        batch: { enabled: true, endpoint: '/batch', flushIntervalMs: 5 }
    }),
    relations: () => ({
        author: belongsTo(UsersStore, { foreignKey: 'authorId' }),
        comments: hasMany(CommentsStore, { foreignKey: 'postId' })
    })
})

PostsStore.useFindMany({ include: {} })
