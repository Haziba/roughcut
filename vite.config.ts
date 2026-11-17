import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { assistantBridge } from './assistant-bridge';

export default defineConfig({
  plugins: [react(), assistantBridge()],
  // AI props are written into props/ while the app runs; they aren't source files.
  server: { watch: { ignored: ['**/props/**', '**/tools/**'] } },
});
