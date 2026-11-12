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
    // 三入口：index.html 是岛，settings.html 是独立设置窗口（SPEC-settings-shell），
    // pet.html 是桌宠独立小窗口（SPEC-deskpet-out）。
    // 产物都落在 out/renderer/ 下，package.json 的 build.files 用 "out/**" 已覆盖，无需另配。
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          settings: resolve('src/renderer/settings.html'),
          pet: resolve('src/renderer/pet.html')
        },
        output: {
          // 两个入口共用 React：不显式分组时，Rollup 会把共享包按「第一个引用它的模块」命名，
          // 于是产物里出现一个叫 Pet-xxxx.js 的 587 kB 文件（实际是 react-dom），
          // 打开看的人会以为是桌宠资源。这里固定叫 vendor，大小和归属一眼能对上。
          //
          // 注意：本项目用 rolldown-vite，`manualChunks` 只接受函数形式，
          // 传对象会直接报 `TypeError: manualChunks is not a function`（实测）。
          manualChunks: (id: string) =>
            /node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id) ? 'vendor' : undefined
        }
      }
    },
    plugins: [react()]
  }
})
