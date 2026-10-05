import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// In development the app calls /api on its own origin and Vite forwards those calls to the
// OpenLeaf API, so the browser never makes a cross-origin request.
//   OPENLEAF_API=http://localhost:3000 npm run dev     (an API running on this machine)
// Without OPENLEAF_API the hosted instance is used.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const target = env.OPENLEAF_API || 'https://openleaf-api.onrender.com';
  const forward = { target, changeOrigin: true, secure: true };
  return {
    plugins: [react()],
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
