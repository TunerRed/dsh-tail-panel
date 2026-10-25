/**
 * dsh-tail-panel — 宿主半边。
 *
 * 只做一件事：把「会话日志尾巴」以 HTTP 形式吐给前端。
 *   GET /dsh-tail-api?op=list
 *   GET /dsh-tail-api?op=tail&session=<id|dir>&after=<ord>&limit=<n>
 *
 * 会话日志是 session.v4.jsonl.zstd（多帧拼接的 zstd），Node 自带解压只认第一帧，
 * 真正的帧遍历在 lib/tail-core.js 里。
 */
import { listSessions, pickSession, Tailer, Formatter } from './lib/tail-core.js'

export const name = 'dsh-tail-panel'
export const inject = ['webServer']

const ROUTE = '/dsh-tail-api'
const MAX_LINES = 4000

// ── 只认本机：Host 头必须是回环地址 ──
function hostIsLoopback(req) {
  const host = String(req.headers?.host || '').toLowerCase()
  const name = host.replace(/:\d+$/, '')
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1'
}

function denyNonLoopback(req, res) {
  if (hostIsLoopback(req)) return false
  res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('只允许本机访问')
  return true
}

function json(res, obj, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(obj))
}

export function apply(ctx) {
  const webServer = ctx.webServer ?? ctx.get('webServer')
  if (!webServer) return

  /** file → { tailer, formatter, lines: [], ord } */
  const states = new Map()

  function stateOf(file) {
    let st = states.get(file)
    if (!st) {
      st = { tailer: new Tailer(file), formatter: new Formatter(), lines: [], ord: -1 }
      states.set(file, st)
    }
    return st
  }

  /** 增量格式化：返回本次新产生的行（客户端按增量 concat，绝不能回全量） */
  function sync(st) {
    // 只处理「还没格式化过」的事件，保证 tool/result 能对上 tool/call 的名字
    st.tailer.refresh()
    const entries = st.tailer.slice(st.ord === -1 ? null : st.ord)
    if (!entries.length) return []
    const added = []
    for (const entry of entries) {
      st.ord = entry.ord
      const line = st.formatter.format(entry)
      if (line) { st.lines.push(line); added.push(line) }
    }
    if (st.lines.length > MAX_LINES) st.lines = st.lines.slice(st.lines.length - MAX_LINES)
    return added
  }

  function snapshot(st, lines) {
    const now = Date.now()
    const calls = [...st.formatter.calls.entries()]
    return {
      lines,
      ord: st.ord,
      dropped: st.tailer.dropped,
      status: {
        turn: st.formatter.turn,
        step: st.formatter.step,
        idleMs: st.formatter.lastEventTs ? now - st.formatter.lastEventTs : 0,
        pending: calls.map(([id, c]) => ({ id, name: c.name, ms: now - c.ts })),
      },
    }
  }

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler(req, res) {
      if (denyNonLoopback(req, res)) return
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' })
        res.end()
        return
      }
      try {
        const u = new URL(req.url || '/', 'http://127.0.0.1')
        const op = u.searchParams.get('op') || 'tail'

        if (op === 'list') {
          const list = listSessions()
          return json(res, {
            ok: true,
            sessions: list.slice(0, 80).map((s) => ({
              id: s.id,
              sessionId: s.sessionId,
              group: s.group,
              size: s.size,
              mtime: s.mtime,
            })),
          })
        }

        if (op === 'tail') {
          const list = listSessions()
          const sess = pickSession(list, u.searchParams.get('session') || undefined)
          if (!sess) return json(res, { ok: false, error: '没有找到任何会话日志（session.v4.jsonl.zstd）' }, 404)

          const st = stateOf(sess.file)
          const full = u.searchParams.get('full') === '1'
          const all = u.searchParams.get('all') === '1'
          if (full) {
            st.tailer = new Tailer(sess.file)
            st.formatter = new Formatter()
            st.lines = []
            st.ord = -1
          }
          const added = sync(st)
          // full/all → 全量快照；普通轮询 → 只回新增，客户端才敢 concat
          const lines = (full || all) ? st.lines.slice(-MAX_LINES) : added
          const snap = snapshot(st, lines)
          return json(res, {
            ok: true,
            session: { id: sess.id, sessionId: sess.sessionId, group: sess.group, size: sess.size, mtime: sess.mtime },
            ...snap,
          })
        }

        return json(res, { ok: false, error: '未知操作: ' + op }, 400)
      } catch (error) {
        return json(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
      }
    },
  }), 'dsh-tail-panel: ' + ROUTE)
}
