/**
 * dsh-tail-panel — 客户端半边。
 *
 * 两块界面：
 *   1. better-sidebar 标签页「日志尾巴」（每会话一个，自动对上当前会话的日志文件）
 *   2. 输入框左侧的 🪵 按钮（点一下把侧边栏那个标签页叫出来）
 *
 * 数据只走宿主提供的 /dsh-tail-api，前端不碰文件系统。
 */
window.__ModuleLoader__.load({
  id: 'dsh-tail-panel',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { useState, useEffect, useRef, useCallback } = React
    const h = React.createElement

    const TAB_TYPE = 'dsh-tail-panel:log'
    // 页签图标的色：终端青绿，和侧栏那排彩色图标同一明度档
    const TAB_ICON_COLOR = '#4EC9B0'
    // 图标底板的浅填充，让 16px 下也有「窗口」的实体感
    const TAB_ICON_FILL = 'rgba(78, 201, 176, 0.13)'
    const POLL_MS = 1200
    const MAX_ROWS = 2000

    const CSS = `
      .dtp-wrap{display:flex;flex-direction:column;height:100%;min-height:240px;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-primary)}
      .dtp-bar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-line-subtle,#3333)}
      .dtp-bar select{background:var(--dsw-alias-bg-secondary,#2a2a2a);color:inherit;border:1px solid var(--dsw-alias-line,#4446);border-radius:5px;padding:2px 4px;max-width:220px;font-size:11px}
      .dtp-btn{background:var(--dsw-alias-bg-secondary,#2a2a2a);color:inherit;border:1px solid var(--dsw-alias-line,#4446);border-radius:5px;padding:2px 7px;font-size:11px;cursor:pointer;line-height:1.6}
      .dtp-btn:hover{background:var(--dsw-alias-bg-tertiary,#333)}
      .dtp-state{margin-left:auto;display:flex;gap:8px;align-items:center;font-size:11px;color:var(--dsw-alias-label-secondary,#9aa)}
      .dtp-dot{width:7px;height:7px;border-radius:50%;background:#3fb950;display:inline-block}
      .dtp-dot.busy{background:#58a6ff;animation:dtp-pulse 1.2s ease-in-out infinite}
      .dtp-dot.warn{background:#d29922}
      .dtp-dot.idle{background:#555}
      @keyframes dtp-pulse{0%,100%{opacity:1}50%{opacity:.35}}
      .dtp-list{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:6px 0;font-family:var(--dsw-alias-font-mono,ui-monospace,Consolas,monospace);line-height:1.62}
      .dtp-row{display:flex;gap:8px;padding:0 10px;white-space:pre-wrap;word-break:break-word}
      .dtp-row:hover{background:var(--dsw-alias-bg-secondary,#ffffff08)}
      .dtp-t{color:#6e7681;flex:none;font-size:11px;padding-top:1px}
      .dtp-x{flex:1;min-width:0}
      .dtp-turn{color:#79c0ff;font-weight:600}
      .dtp-step{color:#8b949e}
      .dtp-dim{color:#6e7681}
      .dtp-think{color:#9aa0a6;font-style:italic}
      .dtp-say{color:#e6edf3}
      .dtp-user{color:#e3b341}
      .dtp-tool{color:#a5d6ff}
      .dtp-cmd{color:#d2a8ff}
      .dtp-ok{color:#7ee787}
      .dtp-err{color:#ff7b72}
      .dtp-warn{color:#d29922}
      .dtp-meta{color:#8b949e}
      .dtp-errline{padding:6px 10px;color:#ff7b72}
      .dtp-empty{padding:20px 12px;color:#6e7681;text-align:center}
      .dsh-tail-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:6px;border:none;background:transparent;cursor:pointer;font-size:15px;opacity:.75}
      .dsh-tail-btn:hover{opacity:1;background:var(--dsw-alias-bg-secondary,#ffffff10)}
    `

    function ownedStyle(text) {
      const el = document.createElement('style')
      el.setAttribute('data-dsh-tail-panel', '1')
      el.textContent = text
      document.head.appendChild(el)
      return el
    }

    const pad2 = (n) => String(n).padStart(2, '0')
    function fmtTime(ts) {
      if (!ts) return '--:--:--'
      const d = new Date(ts)
      return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
    }
    function fmtAgo(ms) {
      const s = Math.max(0, Math.round(ms / 1000))
      if (s < 60) return `${s}s`
      const m = Math.floor(s / 60)
      if (m < 60) return `${m}m${s % 60}s`
      return `${Math.floor(m / 60)}h${m % 60}m`
    }
    function fmtSize(n) {
      if (n > 1024 * 1024) return (n / 1048576).toFixed(1) + 'MB'
      if (n > 1024) return Math.round(n / 1024) + 'KB'
      return n + 'B'
    }

    // ───────────────────────── 日志主体 ─────────────────────────
    function TailPanel(props) {
      const scope = props.scope || {}
      const ctx = props.ctx
      const visible = props.visible !== false
      const [sessions, setSessions] = useState([])
      const [sel, setSel] = useState('')
      const [rows, setRows] = useState([])
      const [status, setStatus] = useState(null)
      const [paused, setPaused] = useState(false)
      const [err, setErr] = useState('')
      const ordRef = useRef(-1)
      const listRef = useRef(null)
      const stickRef = useRef(true)

      // 会话选择：优先当前会话，找不到再退到「最新」
      useEffect(() => {
        let alive = true
        fetch('/dsh-tail-api?op=list')
          .then((r) => r.json())
          .then((d) => {
            if (!alive) return
            if (!d || !d.ok) { setErr((d && d.error) || '读取会话列表失败'); return }
            const list = d.sessions || []
            setSessions(list)
            const mine = scope.sessionId ? list.find((s) => s.sessionId === scope.sessionId) : null
            const def = mine || list[0]
            if (def) setSel((cur) => cur || def.id)
          })
          .catch((e) => alive && setErr(String((e && e.message) || e)))
        return () => { alive = false }
      }, [scope.sessionId])

      // 切会话 → 清屏重来
      const prevSel = useRef('')
      useEffect(() => {
        if (prevSel.current && prevSel.current !== sel) {
          setRows([]); setStatus(null); ordRef.current = -1; stickRef.current = true
        }
        prevSel.current = sel
      }, [sel])

      // 轮询（标签页不可见就停下，别在后台空转）
      useEffect(() => {
        if (!sel || paused || !visible) return undefined
        let alive = true
        let timer = 0
        const tick = async () => {
          try {
            // 首次（刚切会话 / 刚打开）= 要全量历史；之后只拉 after 之后的增量
            const first = ordRef.current === -1
            const q = `/dsh-tail-api?op=tail&session=${encodeURIComponent(sel)}` +
              (first ? '&all=1' : `&after=${ordRef.current}`)
            const r = await fetch(q)
            const d = await r.json()
            if (!alive) return
            if (!d || !d.ok) { setErr((d && d.error) || '读取失败'); return }
            setErr('')
            if (Array.isArray(d.lines) && d.lines.length) {
              setRows((prev) => {
                const next = prev.concat(d.lines)
                return next.length > MAX_ROWS ? next.slice(next.length - MAX_ROWS) : next
              })
            }
            if (typeof d.ord === 'number') ordRef.current = d.ord
            if (d.status) setStatus(d.status)
          } catch (e) {
            if (alive) setErr(String((e && e.message) || e))
          }
        }
        tick()
        timer = setInterval(tick, POLL_MS)
        return () => { alive = false; clearInterval(timer) }
      }, [sel, paused, visible])

      // 自动贴底
      useEffect(() => {
        const el = listRef.current
        if (el && stickRef.current) el.scrollTop = el.scrollHeight
      }, [rows])

      const onScroll = useCallback(() => {
        const el = listRef.current
        if (!el) return
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
      }, [])

      const reloadAll = async () => {
        if (!sel) return
        try {
          const r = await fetch(`/dsh-tail-api?op=tail&session=${encodeURIComponent(sel)}&full=1`)
          const d = await r.json()
          if (!d || !d.ok) { setErr((d && d.error) || '重载失败'); return }
          setRows(d.lines || [])
          ordRef.current = typeof d.ord === 'number' ? d.ord : -1
          if (d.status) setStatus(d.status)
          stickRef.current = true
        } catch (e) { setErr(String((e && e.message) || e)) }
      }

      const copyAll = () => {
        const text = rows.map((r) => `${fmtTime(r.t)}  ${r.text}`).join('\n')
        navigator.clipboard?.writeText(text).catch(() => {})
      }

      const cur = sessions.find((s) => s.id === sel) || null
      const st = status
      const busy = !!(st && st.pending && st.pending.length)
      const idle = st ? st.idleMs : 0
      const dotCls = busy ? 'busy' : idle > 60000 ? 'warn' : idle > 15000 ? 'idle' : ''

      const stateText = (() => {
        if (!st) return '等待数据…'
        const pos = st.turn != null ? `第 ${st.turn} 轮` + (st.step != null ? ` · 第 ${st.step} 步` : '') : ''
        if (busy) {
          const p = st.pending[0]
          return `${pos}${pos ? ' · ' : ''}⌛ ${p.name} 已跑 ${fmtAgo(p.ms)}`
        }
        if (idle > 15000) return `${pos}${pos ? ' · ' : ''}⚠ 空闲 ${fmtAgo(idle)}`
        return `${pos}${pos ? ' · ' : ''}空闲 ${fmtAgo(idle)}`
      })()

      return h('div', { className: 'dtp-wrap' },
        h('div', { className: 'dtp-bar' },
          h('select', {
            value: sel,
            onChange: (e) => setSel(e.target.value),
            title: '选择要盯的会话',
          }, sessions.length
            ? sessions.map((s) => h('option', { key: s.id, value: s.id },
                `${s.group || s.id} · ${s.sessionId.slice(0, 8)} · ${fmtSize(s.size)}`))
            : h('option', { value: '' }, '（没有会话日志）')),
          h('button', { className: 'dtp-btn', onClick: () => setPaused((p) => !p), title: '暂停/继续刷新' }, paused ? '▶ 继续' : '⏸ 暂停'),
          h('button', { className: 'dtp-btn', onClick: reloadAll, title: '从头重新载入最近日志' }, '🔄 重载'),
          h('button', { className: 'dtp-btn', onClick: () => setRows([]), title: '只清屏，不影响采集' }, '🧹 清屏'),
          h('button', { className: 'dtp-btn', onClick: copyAll, title: '复制当前可见日志' }, '📋 复制'),
          h('button', {
            className: 'dtp-btn',
            // Electron 桌面端没有 Ctrl+R / 刷新菜单项，这里给个出口：
            // 改完客户端插件点一下即可重新加载整个 GUI，不必退出程序。
            onClick: () => { try { location.reload() } catch { /* 无 location 环境 */ } },
            title: '重新加载整个界面（改了客户端插件后用这个，不必重启 DSH）',
          }, '⟳ 刷新界面'),
          h('div', { className: 'dtp-state' },
            h('span', { className: 'dtp-dot ' + dotCls }),
            h('span', { title: cur ? cur.id : '' }, stateText),
          ),
        ),
        err ? h('div', { className: 'dtp-errline' }, '✖ ' + err) : null,
        h('div', { className: 'dtp-list', ref: listRef, onScroll },
          rows.length
            ? rows.map((r) => h('div', { className: 'dtp-row', key: r.i },
                h('span', { className: 'dtp-t' }, fmtTime(r.t)),
                h('span', { className: 'dtp-x dtp-' + (r.lvl || 'dim') }, r.text),
              ))
            : h('div', { className: 'dtp-empty' }, paused ? '已暂停' : '暂无日志（点「🔄 重载」拉一次，或等新事件）'),
        ),
      )
    }

    // ───────────────────────── 输入框按钮 ─────────────────────────
    function makeLogButton(ctx) {
      return function LogButton() {
        const open = () => {
          const bs = ctx.get('betterSidebar')
          if (bs && typeof bs.openTab === 'function') {
            try {
              bs.openTab({ type: TAB_TYPE, title: '日志尾巴' })
              return
            } catch { /* 落到提示 */ }
          }
          try {
            // 没有侧边栏服务时给个明确说法，别静默
            // eslint-disable-next-line no-console
            console.warn('[dsh-tail-panel] betterSidebar 服务未就绪，openTab 跳过')
            // eslint-disable-next-line no-alert
            alert('日志尾巴：侧边栏服务（betterSidebar）未就绪。\n请确认 dsh-better-sidebar 已启用后刷新页面。')
          } catch { /* 无 alert 环境 */ }
        }
        return h('button', { className: 'dsh-tail-btn', title: '运行日志尾巴（实时看 DSH 在干什么）', onClick: open }, '🪵')
      }
    }

    // 页签图标：早先传的是 emoji 字符串「🪵」，在 + 菜单里渲染成了宿主默认的
    // 方块图标（2026-10-25 实测）。换成 24×24 线框 SVG 后正常，笔触比照宿主
    // 自带图标（1.7 描边）；颜色固定成终端青绿，不用 currentColor——侧栏那排
    // 本来都是彩色的，纯白反而像个没上色的占位。
    // 造型：终端窗口 + 提示符箭头。
    function tailTabIcon(size) {
      const s = size || 16
      return h(
        'svg',
        {
          width: s,
          height: s,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: TAB_ICON_COLOR,
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('rect', { x: 3, y: 4.5, width: 18, height: 15, rx: 2.5, fill: TAB_ICON_FILL }),
        h('path', { d: 'M3 8.8h18' }),
        h('path', { d: 'M6.8 12.7l2.6 2.6-2.6 2.6' }),
        h('path', { d: 'M12.6 17.9h4.6' }),
      )
    }

    function apply(ctx) {
      try {
        // eslint-disable-next-line no-console
        console.info('[dsh-tail-panel] client apply', {
          slots: !!ctx.get('slots'),
          betterSidebar: !!ctx.get('betterSidebar'),
        })
      } catch { /* 无 console 环境 */ }
      const styleEl = ownedStyle(CSS)
      ctx.effect(() => () => styleEl.remove(), 'dsh-tail-panel: styles')

      const slots = ctx.get('slots')
      if (slots !== undefined) {
        // 输入框左侧按钮：一点就把侧边栏标签页叫出来
        const LogButton = makeLogButton(ctx)
        slots.inject('conversation.input.left', () => slots.register(
          { name: 'conversation.input.left', id: 'dsh-tail-log', order: 6, label: '日志尾巴' },
          () => h(LogButton),
        ))
      }

      // betterSidebar 可能比本插件晚 apply：用运行时注入等它就绪再注册，
      // 否则 ctx.get() 拿到 undefined 会静默跳过注册（页签无效、点按钮只弹提示）。
      ctx.inject(['betterSidebar'], (ctx2) => {
        const bs = ctx2.get('betterSidebar')
        if (!bs || typeof bs.registerTab !== 'function') return
        ctx2.effect(() => bs.registerTab({
          id: TAB_TYPE,
          title: '日志尾巴',
          description: '实时看 DSH 这轮跑到哪一步（工具调用 / 心跳 / 报错）',
          icon: tailTabIcon,
          order: 60,
          single: true,
          component: (props) => h(TailPanel, props),
        }), 'dsh-tail-panel: sidebar tab')
      })
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
