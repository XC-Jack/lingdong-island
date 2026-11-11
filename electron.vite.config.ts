import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    // 双入口（SPEC-settings-shell）：index.html 是岛，settings.html 是独立设置窗口。
    // 两者产出落在 out/renderer/ 下，package.json 的 build.files 用 "out/**" 已覆盖，无需另配。
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          settings: resolve('src/renderer/settings.html')
        }
      }
    },
    plugins: [react()]
  }
})
