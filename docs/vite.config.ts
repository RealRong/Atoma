import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';
import mdx from 'fumadocs-mdx/vite';
import * as MdxConfig from './source.config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    dedupe: ['react', 'react-dom', 'jotai'],
    alias: {
      '@': path.resolve(__dirname, 'app'),
    },
  },
  ssr: {
    noExternal: ['atoma'],
  },
  plugins: [
    mdx(MdxConfig),
    tailwindcss(),
    reactRouter(),
    tsconfigPaths({
      root: __dirname,
    }),
  ],
});
