import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 开发时自动启动 SQLite HTTP demo server（依赖系统 sqlite3 CLI）
if (process.env.START_SQLITE_SERVER !== 'false') {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require('./server')
    } catch (err: any) {
        console.warn('[demo] 启动 sqlite demo server 失败，可设置 START_SQLITE_SERVER=false 跳过。', err?.message || err)
    }
}

export default defineConfig({
    root: __dirname,
    base: './',
    plugins: [react()],
    resolve: {
        alias: {
            atoma: path.resolve(__dirname, '../src')
        }
    },
    build: {
        outDir: '../docs',
        emptyOutDir: true
    }
})
