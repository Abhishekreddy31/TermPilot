import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const devServer = process.env.TERMPILOT_DEV_SERVER ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/favicon.svg'],
      manifest: {
        name: 'TermPilot',
        short_name: 'TermPilot',
        description: 'Mobile-first terminal management with voice control',
        theme_color: '#0d1117',
        background_color: '#0d1117',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        icons: [
          { src: '/icons/icon-192.svg', sizes: '192x192', type: 'image/svg+xml' },
          { src: '/icons/icon-512.svg', sizes: '512x512', type: 'image/svg+xml' },
          { src: '/icons/icon-512.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'maskable' },
          { src: '/icons/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        runtimeCaching: [],
        navigateFallback: 'index.html',
      },
    }),
  ],
  oxc: {
    jsx: { runtime: 'automatic', importSource: 'preact' },
  },
  server: {
    // `pnpm dev` runs the TermPilot server separately; point at it with TERMPILOT_DEV_SERVER.
    proxy: {
      '/ws': { target: devServer, ws: true },
      '/api': { target: devServer },
      '/health': { target: devServer },
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
});
