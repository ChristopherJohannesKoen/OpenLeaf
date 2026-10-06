import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * A Content-Security-Policy for the built site, written into index.html so that it holds on any
 * static host (no server setting needed). It limits what a bug in the app could do: script only
 * from the site itself (and Google's sign-in loader), connections only to the API and to Google's
 * sign-in service, no plugins, no forms posted elsewhere. Not applied in `npm run dev`.
 *
 * `frame-ancestors` cannot be set from a page, so a host that allows response headers should also
 * send it (render.yaml does).
 */
function contentSecurityPolicy(apiUrl: string | undefined): Plugin {
  let apiOrigin = '';
  try {
    if (apiUrl) apiOrigin = new URL(apiUrl).origin;
  } catch {
    /* a relative or odd address: the API is on the site's own origin */
  }
  const policy = [
    "default-src 'self'",
    "script-src 'self' https://apis.google.com",
    // CodeMirror and the design system set styles from script.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${apiOrigin} https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com`.replace(/\s+/g, ' '),
    // Google sign-in runs through a frame on the Firebase project's own address.
    'frame-src https://*.firebaseapp.com https://*.web.app',
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
  return {
    name: 'openleaf-content-security-policy',
    apply: 'build',
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy }, injectTo: 'head-prepend' },
      { tag: 'meta', attrs: { name: 'referrer', content: 'no-referrer' }, injectTo: 'head-prepend' },
    ],
  };
}

// In development the app calls /api on its own origin and Vite forwards those calls to the
// OpenLeaf API, so the browser never makes a cross-origin request.
//   OPENLEAF_API=http://localhost:3000 npm run dev     (an API running on this machine)
// Without OPENLEAF_API the hosted instance is used.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const target = env.OPENLEAF_API || 'https://openleaf-api.onrender.com';
  const forward = { target, changeOrigin: true, secure: true };
  return {
    plugins: [react(), contentSecurityPolicy(env.VITE_API_URL)],
    // Shown on the sign-in screen while developing, so it is plain which service is being used.
    define: { __OPENLEAF_PROXY__: JSON.stringify(target) },
    server: {
      port: Number(env.PORT) || 5173,
      proxy: { '/api': forward, '/healthz': forward },
    },
    preview: { port: 4173, proxy: { '/api': forward, '/healthz': forward } },
    build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
    test: { environment: 'node', include: ['src/**/*.test.ts'] },
  };
});
