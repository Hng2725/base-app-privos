import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'src/ui',
  base: './',
  server: {
    cors: true,
  },
  build: {
    outDir: '../../dist/ui',
    emptyOutDir: true,
    manifest: true,
    sourcemap: false,
    // Every referenced asset becomes a real hashed `assets/` file, never an inlined base64
    // data URI — split-asset serving needs a filename to address over `ui://…/assets/<file>`.
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        // Hex, not Rollup's default base64url. A base64url hash may begin with `-` or `_`,
        // which yields names like `index--IpuopkB.js` — a double dash whose acceptance then
        // depends on every consumer of the shared content-hashed filename rule agreeing about
        // it, including the Hub route that re-serves these files. Roughly one build in thirty
        // draws such a hash, so the failure is intermittent and looks like a code regression
        // rather than a build one. Hex removes the class of bug outright.
        hashCharacters: 'hex',
        // Split-asset serving caps each `assets/` file at 2 MB, so the heavy
        // document/spreadsheet/icon libraries get their own chunks instead of
        // riding along in one oversized entry bundle.
        manualChunks: {
          vendor: ['react', 'react-dom', '@privos_ai/app-react'],
          docx: ['docx'],
          xlsx: ['xlsx'],
          icons: ['@ant-design/icons'],
        },
      },
    },
  },
});
