import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/favicon.svg'],
      manifest: {
        name: 'TermPilot',
        short_name: 'TermPilot',
        description: 'Mobile-first terminal management with voice control',
        theme_color: '#1e1e1e',
        background_color: '#1e1e1e',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        runtimeCaching: [
          {
            urlPattern: /^https?:\/\/.*\/api\//,
            handler: 'NetworkFirst',
            options: { cacheName: 'api-cache', expiration: { maxEntries: 10 } },
          },
        ],
      },
    }),
  ],
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  resolve: {
    alias: {
      'react': 'preact/compat',
      'react-dom': 'preact/compat',
    },
  },
  server: {
    proxy: {
      '/ws': { target: 'ws://localhost:3000', ws: true },
      '/api': { target: 'http://localhost:3000' },
      '/health': { target: 'http://localhost:3000' },
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
});
