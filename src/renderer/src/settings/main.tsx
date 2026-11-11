import ReactDOM from 'react-dom/client'
import SettingsApp from './SettingsApp'
import './settings.css'

/**
 * 设置窗口的渲染入口（SPEC-settings-shell）。
 * 与岛的主入口 src/renderer/src/main.tsx 分开：两个窗口挂不同的页面
 * （settings.html ↔ index.html），也各带各的样式，互不污染。
 * 不开 StrictMode：设置页没有副作用探针需求，且自启开关的乐观更新在
 * 双次挂载下容易闪一下（岛那边保留原样，不动）。
 */
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<SettingsApp />)
