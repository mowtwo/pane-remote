import { lease, ready as leaseReady } from '$lib/lease.svelte' // 必须第一个：要在任何请求之前包好 fetch / EventSource / WebSocket
import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { report, flushReports, pendingReports } from '$lib/api'
import { toast } from 'svelte-sonner'
import { update } from '$lib/update.svelte'

// 报错发回服务端，方便排查手机上的问题（pane-remote logs 里搜 client）
// 浏览器对跨域脚本（Safari 扩展 / 注入脚本等）的报错只给 "Script error."，没有文件、行号、堆栈：不是我们的代码，没法排查，不上报
const opaque = (e: ErrorEvent) => !e.filename && !e.lineno && !e.error && /^Script error\.?$/.test(e.message)
addEventListener('error', (e) => opaque(e) ? undefined : report('error', `${e.message} @ ${e.filename}:${e.lineno}:${e.colno} ${e.error?.stack || ''}`))
addEventListener('unhandledrejection', (e) => (lease.status === 'kicked' || lease.status === 'local') ? undefined : report('rejection', e.reason?.stack || e.reason?.message || e.reason))
const build = (document.querySelector('script[src*="assets/index-"]') as HTMLScriptElement | null)?.src.split('/').pop() || 'dev'
declare const __BUILD_TIME__: string
import { APP_VERSION } from '$lib/version'
// 启动：带上这次是怎么打开的（navigate / reload / back_forward）、离上次启动多久、上次留下几条没发出去的报错——
// 连不上时人会反复重开 App，光看到一串 boot 分不清是人在重开还是页面自己崩了重载
let lastBoot = 0
try { lastBoot = Number(localStorage.getItem('pr-last-boot')) || 0; localStorage.setItem('pr-last-boot', String(Date.now())) } catch {}
const navType = (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type || '?'
report('boot', `v${APP_VERSION} ${build} ${__BUILD_TIME__} ${innerWidth}x${innerHeight} dpr=${devicePixelRatio} standalone=${(navigator as any).standalone} nav=${navType} since=${lastBoot ? Math.round((Date.now() - lastBoot) / 1000) + 's' : '-'} queued=${pendingReports()} online=${navigator.onLine}`)
flushReports()
// 界面上弹出的错误提示（「xx 失败」）也记一条：以前用户看到了，日志里什么都没有
const toastError = toast.error
toast.error = ((msg: unknown, opts?: unknown) => {
  if (lease.status === 'kicked' || lease.status === 'local') return 0 // 被顶 / 本机：请求失败是预期的，别弹错误、别上报
  report('ui-fail', typeof msg === 'string' ? msg : String(msg), { view: location.hash.slice(0, 80) }); return (toastError as any)(msg, opts) }) as typeof toast.error

// iOS Safari 无视 user-scalable=no，双指缩放要自己拦；键盘收起后页面偶尔停在被推上去的位置，拉回来
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false })
document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault() }, { passive: false })
document.addEventListener('focusout', () => setTimeout(() => { if (!document.activeElement || document.activeElement === document.body) window.scrollTo(0, 0) }, 50))

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {})

// 检查新版本：切回前台、每 10 分钟拉一次首页，资源文件名（带内容哈希）变了就在顶栏亮「更新」按钮
// （不用常驻的提示层：会挡住顶栏）。iOS 主屏幕 App 从后台回来不会重新加载页面，不提示的话会一直停在旧版。
let notified = false
async function checkUpdate() {
  if (notified || build === 'dev' || document.visibilityState !== 'visible') return
  try {
    const html = await (await fetch('./', { cache: 'no-store' })).text()
    const latest = html.match(/assets\/(index-[^"]+\.js)/)?.[1]
    if (latest && latest !== build) {
      notified = true
      update.available = true
    }
  } catch {}
}
document.addEventListener('visibilitychange', checkUpdate)
setInterval(checkUpdate, 10 * 60000)
setTimeout(checkUpdate, 5000)

// 主脚本已经跑起来了：index.html 的「没显示」检测据此知道只是在等接管（慢网络下最多 5 秒），不是脚本坏了
;(window as any).__booted = true
await leaseReady
const app = mount(App, { target: document.getElementById('app')! })
// 诊断：安全区和各种高度（iOS 主屏幕 App 的布局问题靠这个查）
setTimeout(() => {
  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;visibility:hidden;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)'
  document.body.appendChild(probe)
  const cs = getComputedStyle(probe)
  const vv = window.visualViewport
  report('layout', `inset t${cs.paddingTop} r${cs.paddingRight} b${cs.paddingBottom} l${cs.paddingLeft} inner ${innerWidth}x${innerHeight} vv ${vv ? `${Math.round(vv.width)}x${Math.round(vv.height)}+${Math.round(vv.offsetTop)}` : '-'} screen ${screen.width}x${screen.height} doc ${document.documentElement.clientHeight} body ${document.body.getBoundingClientRect().height} vvh ${getComputedStyle(document.documentElement).getPropertyValue('--vvh')}`)
  probe.remove()
}, 1500)
;(window as any).__mounted = true // index.html 里的保底脚本据此判断页面有没有显示出来
export default app
