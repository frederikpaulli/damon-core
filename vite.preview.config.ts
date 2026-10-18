import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'src/renderer/preview',
  plugins: [react()],
  build: { outDir: '../../../out/preview', emptyOutDir: true }
})
