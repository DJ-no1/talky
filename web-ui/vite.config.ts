import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

/** Talky control server is plain HTTP. TLS errors often mean this URL used https:// by mistake. */
function normalizeApiProxyTarget(raw: string): string {
  const t = raw.trim()
  if (!t) return t
  try {
    const u = new URL(/^https?:\/\//i.test(t) ? t : `http://${t}`)
    const h = u.hostname.toLowerCase()
    const loopback = h === 'localhost' || h === '127.0.0.1' || h === '::1'
    if (loopback && u.protocol === 'https:') {
      console.warn(
        '[Talky] VITE_API_PROXY_TARGET used https:// for loopback; control server is HTTP only; using http://.',
      )
      u.protocol = 'http:'
    }
    return u.toString().replace(/\/+$/, '')
  } catch {
    return t
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Corporate HTTP(S)_PROXY can break `/api` proxying to loopback; ensure bypass.
  const loop = '127.0.0.1,localhost,::1'
  process.env.NO_PROXY = [process.env.NO_PROXY, loop].filter(Boolean).join(',')

  // Root `.env` has `WEB_UI_PORT` for Talky; web-ui `.env*` overrides (e.g. `VITE_API_PROXY_TARGET`).
  const env = {
    ...loadEnv(mode, repoRoot, ''),
    ...loadEnv(mode, __dirname, ''),
  }
  const proxyTarget = normalizeApiProxyTarget(
    env.VITE_API_PROXY_TARGET?.trim() ||
      `http://127.0.0.1:${env.WEB_UI_PORT?.trim() || '4173'}`,
  )

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      proxy: {
        '/api': {
          target: proxyTarget,
          changeOrigin: true,
          /** Avoid proxy "socket hang up" when Talky is slow (e.g. cold network) or briefly busy. */
          timeout: 120_000,
          proxyTimeout: 120_000,
        },
      },
    },
  }
})
