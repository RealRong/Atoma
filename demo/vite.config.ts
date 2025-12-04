import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

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
