import ReactDOM from 'react-dom/client'
import PetWindowApp from './PetWindowApp'
import './petwin.css'

/**
 * 桌宠独立小窗口的渲染入口（SPEC-deskpet-out）。
 *
 * 与岛的 main.tsx、设置的 settings/main.tsx 各自独立：
 * 三个窗口挂三个 HTML，各带各的样式，互不污染。
 * 不开 StrictMode：这个窗口只有「画桌宠 + 接拖动」，没有副作用探针需求，
 * 双次挂载反而会让 pointerdown 监听注册两遍（实测双击感）。
 */
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<PetWindowApp />)
