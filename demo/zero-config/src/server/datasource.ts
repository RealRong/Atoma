import 'reflect-metadata'
import fs from 'fs'
import path from 'path'
import { DataSource } from 'typeorm'
import { CommentEntity, PostEntity, UserEntity } from './entities'

const DB_DIR = path.resolve(process.cwd(), '.tmp')
const DB_PATH = path.join(DB_DIR, 'atoma-zero-config.sqlite')
fs.mkdirSync(DB_DIR, { recursive: true })

export const AppDataSource = new DataSource({
    type: 'sqlite',
    database: DB_PATH,
    entities: [UserEntity, PostEntity, CommentEntity],
    synchronize: true
})
