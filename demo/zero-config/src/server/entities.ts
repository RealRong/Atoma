import {
    Column,
    Entity,
    ManyToOne,
    OneToMany,
    PrimaryGeneratedColumn
} from 'typeorm'

@Entity('users')
export class UserEntity {
    @PrimaryGeneratedColumn()
    id!: number

    @Column('text')
    name!: string

    @Column('text')
    title!: string

    @Column({ type: 'integer', default: 0 })
    version!: number

    @OneToMany(() => PostEntity, post => post.author)
    posts!: PostEntity[]

    @OneToMany(() => CommentEntity, comment => comment.author)
    comments!: CommentEntity[]
}

@Entity('posts')
export class PostEntity {
    @PrimaryGeneratedColumn()
    id!: number

    @Column('text')
    title!: string

    @Column('text')
    body!: string

    @Column('integer')
    authorId!: number

    @ManyToOne(() => UserEntity, user => user.posts, { onDelete: 'CASCADE' })
    author!: UserEntity

    @OneToMany(() => CommentEntity, comment => comment.post)
    comments!: CommentEntity[]

    @Column({ type: 'integer' })
    createdAt!: number

    @Column({ type: 'integer', default: 0 })
    version!: number
}

@Entity('comments')
export class CommentEntity {
    @PrimaryGeneratedColumn()
    id!: number

    @Column('text')
    body!: string

    @Column('integer')
    postId!: number

    @Column('integer')
    authorId!: number

    @ManyToOne(() => PostEntity, post => post.comments, { onDelete: 'CASCADE' })
    post!: PostEntity

    @ManyToOne(() => UserEntity, user => user.comments, { onDelete: 'CASCADE' })
    author!: UserEntity

    @Column({ type: 'integer' })
    createdAt!: number

    @Column({ type: 'integer', default: 0 })
    version!: number
}
