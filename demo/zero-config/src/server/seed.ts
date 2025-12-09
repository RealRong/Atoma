import { AppDataSource } from './datasource'
import { CommentEntity, PostEntity, UserEntity } from './entities'

export async function ensureSeedData() {
    if (!AppDataSource.isInitialized) {
        await AppDataSource.initialize()
    }

    const userRepo = AppDataSource.getRepository(UserEntity)
    if (await userRepo.count()) return

    const [alice, bob] = await userRepo.save([
        userRepo.create({ name: 'Alice', title: 'Editor' }),
        userRepo.create({ name: 'Bob', title: 'Author' })
    ])

    const postRepo = AppDataSource.getRepository(PostEntity)
    const [p1, p2] = await postRepo.save([
        postRepo.create({
            title: 'SQLite zero-config backend',
            body: 'Only expose /api/batch and the frontend connects automatically.',
            authorId: alice.id,
            createdAt: Date.now() - 30000
        }),
        postRepo.create({
            title: 'Relations auto include',
            body: 'useFindMany(include) will batch related reads.',
            authorId: bob.id,
            createdAt: Date.now() - 15000
        })
    ])

    const commentRepo = AppDataSource.getRepository(CommentEntity)
    await commentRepo.save([
        commentRepo.create({
            body: 'Batch query removes extra round trips',
            postId: p1.id,
            authorId: bob.id,
            createdAt: Date.now() - 20000
        }),
        commentRepo.create({
            body: 'Relations keep include logic declarative',
            postId: p1.id,
            authorId: alice.id,
            createdAt: Date.now() - 10000
        }),
        commentRepo.create({
            body: 'Define entities and the client hooks automatically',
            postId: p2.id,
            authorId: alice.id,
            createdAt: Date.now() - 5000
        })
    ])
}
