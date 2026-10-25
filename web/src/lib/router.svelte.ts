// hash 路由：地址就是界面状态，推送 / 待办 / 提示跳转都只是导航到一个地址（不引入路由库）。
//   #/s/p12                 pane 12
//   #/s/c:<id>              Cursor 会话；#/s/c: = Cursor 但不指定会话（新建草稿 / 还没选）
//   #/plugin/<id>           插件（插件层开在前台；预览 preview、这台电脑 mac、看屏幕 screen 是平台自带的）
//   #/?sheet=incident:<id>  只带面板、不带视图：停在当前视图上打开面板（冷启动时视图按上次位置恢复）
// 查询参数：sheet = 叠在视图上的面板（sessions / inbox / incident[:id]）；open = 要在预览里打开的网页（谁都能构造，打开前要确认）
export type View = { kind: 'pane'; pane: string } | { kind: 'cursor'; id: string } | { kind: 'plugin'; id: string } | { kind: 'none' }
export type Route = { view: View; sheet: string; open: string }

const NONE: View = { kind: 'none' }

export function parse(hash: string): Route {
  const h = hash.replace(/^#/, '')
  const q = h.indexOf('?')
  const path = q < 0 ? h : h.slice(0, q)
  const sp = new URLSearchParams(q < 0 ? '' : h.slice(q + 1))
  let view: View = NONE
  let m: RegExpMatchArray | null
  if ((m = path.match(/^\/s\/p(\d{1,6}|w[0-9A-HJKMNP-TV-Z]{1,13}:p[0-9A-HJKMNP-TV-Z]{1,13})$/))) view = { kind: 'pane', pane: m[1] }
  else if ((m = path.match(/^\/s\/c:([^/]*)$/))) view = { kind: 'cursor', id: decodeURIComponent(m[1]) }
  else if ((m = path.match(/^\/plugin\/([\w.-]+)$/))) view = { kind: 'plugin', id: m[1] }
  return { view, sheet: sp.get('sheet') || '', open: sp.get('open') || '' }
}

export function viewPath(v: View) {
  return v.kind === 'pane' ? `/s/p${v.pane}` : v.kind === 'cursor' ? `/s/c:${encodeURIComponent(v.id)}` : v.kind === 'plugin' ? `/plugin/${v.id}` : '/'
}
export function format(r: Route) {
  const sp = new URLSearchParams()
  if (r.sheet) sp.set('sheet', r.sheet)
  if (r.open) sp.set('open', r.open)
  const qs = sp.toString().replace(/%3A/g, ':')
  return `#${viewPath(r.view)}${qs ? `?${qs}` : ''}`
}
export const sameView = (a: View, b: View) => viewPath(a) === viewPath(b)

// 旧的冷启动参数（推送、旧书签）：?pane= / ?cursor= / ?incident= / ?preview= 转成新地址
function legacy(): Route | null {
  const sp = new URLSearchParams(location.search)
  const pane = sp.get('pane'), cursor = sp.get('cursor'), incident = sp.get('incident'), preview = sp.get('preview')
  if (incident && /^[0-9a-f]{12}$/.test(incident)) return { view: NONE, sheet: `incident:${incident}`, open: '' }
  if (cursor && /^[0-9a-f-]{8,64}$/i.test(cursor)) return { view: { kind: 'cursor', id: cursor }, sheet: '', open: '' }
  if (preview) return { view: { kind: 'plugin', id: 'preview' }, sheet: '', open: preview }
  if (pane && /^(?:\d{1,6}|w[0-9A-HJKMNP-TV-Z]{1,13}:p[0-9A-HJKMNP-TV-Z]{1,13})$/.test(pane)) return { view: { kind: 'pane', pane }, sheet: '', open: '' }
  return null
}

// 上次停在哪（只存视图）：地址为空时恢复用。兼容以前存的 mode（终端 / 预览 / Cursor / 这台电脑）
const LAST_KEY = 'route'
function lastView(): View {
  try {
    const v = parse(localStorage.getItem(LAST_KEY) || '').view
    if (v.kind !== 'none') return v
    const mode = localStorage.getItem('mode')
    if (mode === 'cursor') return { kind: 'cursor', id: localStorage.getItem('cursorSession') || '' }
    if (mode === 'preview') return { kind: 'plugin', id: 'preview' }
    if (mode === 'ext') return { kind: 'plugin', id: 'mac' }
  } catch {}
  return NONE
}

function initial(): Route {
  const old = legacy()
  const r = old || parse(location.hash)
  if (r.view.kind === 'none') r.view = lastView()
  history.replaceState({ ...history.state, sheet: false }, '', location.pathname + format(r))
  return r
}

export const route = $state<Route>(initial())

function apply(r: Route) {
  if (format(r) === format(route)) return
  route.view = r.view; route.sheet = r.sheet; route.open = r.open
  if (r.view.kind !== 'none') try { localStorage.setItem(LAST_KEY, format({ view: r.view, sheet: '', open: '' })) } catch {}
}
// 后退 / 前进 / 手改地址
const sync = () => apply(parse(location.hash))
window.addEventListener('popstate', sync)
window.addEventListener('hashchange', sync)

/**
 * 导航到一个地址（'#/s/p12'、'./#/plugin/preview'，或一个 Route 片段）。
 * 只带面板、不带视图的地址停在当前视图上；默认新增一条历史（后退能回来），replace = 换掉当前这条。
 */
export function navigate(to: string | Partial<Route>, opts: { replace?: boolean } = {}) {
  let next: Route
  if (typeof to === 'string') {
    const i = to.indexOf('#')
    next = parse(i < 0 ? '' : to.slice(i))
    if (next.view.kind === 'none') next.view = route.view
  } else next = { view: to.view ?? route.view, sheet: to.sheet ?? '', open: to.open ?? '' }
  const url = location.pathname + format(next)
  if (format(next) === format(route)) return
  // 面板那一条历史被换掉（在面板里选了会话）：新的这条不再是面板
  const state = { sheet: !!next.sheet }
  if (opts.replace) history.replaceState(state, '', url)
  else history.pushState(state, '', url)
  apply(next)
}

/** 打开面板：新增一条历史，手机的返回手势 / 后退键能关掉它 */
export function openSheet(name: string) {
  if (route.sheet === name) return
  navigate({ view: route.view, sheet: name, open: route.open }, { replace: !!route.sheet && history.state?.sheet })
}
/**
 * 关闭面板。面板是自己新增的那条历史就后退回去，否则原地去掉 sheet。
 * 推迟一拍再看：面板里点了会话时，组件先把 open 置 false、紧接着导航到会话（换掉面板这条历史），这时就不用后退了
 */
export function closeSheet(name?: string) {
  setTimeout(() => {
    if (!route.sheet || (name && !route.sheet.startsWith(name))) return
    if (history.state?.sheet) history.back()
    else navigate({ view: route.view, sheet: '', open: route.open }, { replace: true })
  })
}
/** 给 bind:open 用：面板的开关跟着地址走 */
export const sheetBinding = (name: string) => ({
  get: () => route.sheet === name || route.sheet.startsWith(`${name}:`),
  set: (v: boolean) => (v ? openSheet(name) : closeSheet(name)),
})

/** 去会话 / 插件页：在面板上就换掉面板那条历史（后退回到打开面板之前），否则新增一条 */
export function go(view: View) {
  navigate({ view, sheet: '', open: '' }, { replace: !!route.sheet && history.state?.sheet })
}
export const paneView = (pane: string | number): View => ({ kind: 'pane', pane: String(pane) })
export const cursorView = (id: string): View => ({ kind: 'cursor', id })
export const pluginView = (id: string): View => ({ kind: 'plugin', id })
