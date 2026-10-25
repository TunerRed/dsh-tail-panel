/**
 * tail-core.js — DSH 会话日志尾巴的核心逻辑（宿主侧）
 *
 * 职责：
 *   1. 在多个数据根里找 session.v4.jsonl.zstd；
 *   2. 自带 zstd 多帧遍历器（Node 自带 API 只解第一帧）；
 *   3. 增量读取 + 事件环形缓冲；
 *   4. 把事件格式化成前端直接能渲染的一行行。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const MAX_EVENTS = 6000;   // 环形缓冲上限（够回看最近几千条）
const DEFAULT_BACKLOG = 300; // 前端首次拉取的默认条数

// ───────────────────────── zstd 多帧 ─────────────────────────
function findMagic(buf, from) {
  for (let i = from; i + 4 <= buf.length; i++) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) return i;
  }
  return -1;
}

export function scanFrames(buf, from = 0) {
  const frames = [];
  let i = from;
  while (i + 4 <= buf.length) {
    if (!(buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd)) {
      const nxt = findMagic(buf, i + 1);
      if (nxt < 0) return { frames, nextOffset: buf.length };
      i = nxt;
      continue;
    }
    const start = i;
    i += 4;
    if (i >= buf.length) return { frames, nextOffset: start };
    const fhd = buf[i++];
    const fcsFlag = fhd >> 6;
    const single = (fhd >> 5) & 1;
    const hasChecksum = (fhd >> 2) & 1;
    const didFlag = fhd & 3;
    if (!single) i += 1;
    i += didFlag === 3 ? 4 : didFlag;
    let fcsLen = 0;
    if (fcsFlag === 0) fcsLen = single ? 1 : 0;
    else if (fcsFlag === 1) fcsLen = 2;
    else if (fcsFlag === 2) fcsLen = 4;
    else fcsLen = 8;
    i += fcsLen;
    let truncated = false;
    for (;;) {
      if (i + 3 > buf.length) { truncated = true; break; }
      const v = buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16);
      i += 3;
      const last = v & 1;
      const type = (v >> 1) & 3;
      const size = v >>> 3;
      const need = type === 1 ? 1 : size;
      if (i + need > buf.length) { truncated = true; break; }
      i += need;
      if (last) break;
    }
    if (truncated) return { frames, nextOffset: start };
    if (hasChecksum) i += 4;
    frames.push({ start, end: i });
  }
  return { frames, nextOffset: i };
}

/** 解压一帧 → 事件数组 */
export function frameEvents(buf, start, end) {
  let text;
  try {
    text = zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8');
  } catch {
    return [];
  }
  const list = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { list.push(JSON.parse(s)); } catch { /* 半行 */ }
  }
  return list;
}

// ───────────────────────── 会话定位 ─────────────────────────
/**
 * 会话根目录：只从当前 DSH_HOME 推导，不再枚举写死的盘符候选。
 * 需要额外看别的根时，用 DSH_TAIL_ROOTS 显式指定（path.delimiter 分隔）。
 */
export function sessionRoots(extraHome) {
  const override = String(process.env.DSH_TAIL_ROOTS || '')
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean);
  if (override.length > 0) return [...new Set(override)];

  const home = extraHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const modern = path.join(home, 'data', 'sessions');   // 现行布局
  const legacy = path.join(home, 'sessions');           // 老布局：没有 data 层
  if (fs.existsSync(modern)) return [modern];
  if (fs.existsSync(legacy)) return [legacy];
  return [modern];
}

function walk(root, depth, acc) {
  if (depth > 2) return acc;
  let ents;
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) walk(p, depth + 1, acc);
    else if (/^session\.v\d+\.jsonl\.zst(d)?$/i.test(e.name)) {
      try {
        const st = fs.statSync(p);
        if (st.size > 0) acc.push({ file: p, size: st.size, mtime: st.mtimeMs, dir: path.dirname(p) });
      } catch { /* 读不到就算 */ }
    }
  }
  return acc;
}

const SESSION_NAME_RE = /^session-([0-9a-f-]{8,})$/i;

export function listSessions(home) {
  const byDir = new Map();
  for (const root of sessionRoots(home)) {
    for (const s of walk(root, 0, [])) {
      const prev = byDir.get(s.dir);
      const score = (f, size) => (/\.jsonl\.zstd$/i.test(f) ? 1e15 : 0) + size;
      if (!prev || score(s.file, s.size) > score(prev.file, prev.size)) byDir.set(s.dir, s);
    }
  }
  // 按 sessionId 再收一次：即使多个根里都有关这份会话，列表也只留最新那份。
  const byId = new Map();
  for (const s of byDir.values()) {
    const dirBase = path.basename(s.dir);
    const groupBase = path.basename(path.dirname(s.dir)).replace(/^--|--$/g, '');
    const id = (dirBase.match(SESSION_NAME_RE) || [])[1] || dirBase;
    const item = {
      id: dirBase,            // session-<uuid>
      sessionId: id,          // 纯 uuid
      group: groupBase,       // 例如 G-DSH_WORKSPACE-daily
      file: s.file,
      size: s.size,
      mtime: s.mtime,
    };
    const prev = byId.get(id);
    if (!prev || item.mtime > prev.mtime) byId.set(id, item);
  }
  return [...byId.values()].sort((a, b) => b.mtime - a.mtime);
}

export function pickSession(list, want) {
  if (!want) return list[0];
  const w = String(want);
  return list.find((s) => s.dir === w || s.sessionId === w || s.id === w)
    || list.find((s) => w.length >= 6 && s.sessionId.startsWith(w))
    || list.find((s) => s.id.includes(w))
    || null;
}

// ───────────────────────── 增量读取器 ─────────────────────────
export class Tailer {
  constructor(file) {
    this.file = file;
    this.offset = 0;
    this.size = -1;
    this.events = [];      // 环形缓冲，每项 {ord, ev, t}
    this.ord = -1;         // 最后一条事件的 ord
    this.dropped = 0;      // 被环形缓冲丢掉的条数（前端可提示）
  }

  get absOrd() { return this.ord; }

  refresh() {
    let st;
    try { st = fs.statSync(this.file); } catch { return false; }
    if (st.size === this.size) return false;
    if (st.size < this.offset) { this.offset = 0; this.size = -1; } // 被截断/重建
    let buf;
    try { buf = fs.readFileSync(this.file); } catch { return false; }
    const { frames, nextOffset } = scanFrames(buf, this.offset);
    this.size = buf.length;
    if (!frames.length) { this.offset = nextOffset; return false; }
    for (const f of frames) {
      for (const ev of frameEvents(buf, f.start, f.end)) {
        if (typeof ev.seq === 'number' && ev.seq <= (this.lastSeq ?? -1)) continue;
        if (typeof ev.seq === 'number') this.lastSeq = ev.seq;
        if (ev.type === 'session-log-deepseek/delivery-accepted') continue;
        this.events.push({ ord: ++this.ord, ev });
      }
    }
    this.offset = nextOffset;
    if (this.events.length > MAX_EVENTS) {
      this.dropped += this.events.length - MAX_EVENTS;
      this.events = this.events.slice(this.events.length - MAX_EVENTS);
    }
    return true;
  }

  /** 取 ord > after 的事件；after < 0 表示只要最后 backlog 条 */
  slice(after, backlog = DEFAULT_BACKLOG) {
    if (after === null) return this.events.slice();          // 全部（首屏/重载用）
    if (after == null || after < 0) return this.events.slice(-backlog); // 只要尾巴
    return this.events.filter((x) => x.ord > after);
  }
}

// ───────────────────────── 事件 → 可读行 ─────────────────────────
const MAXTEXT = 200;
const clip = (s, n = MAXTEXT) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const firstLine = (s) => String(s ?? '').split(/\r?\n/).find((x) => x.trim()) ?? '';

export class Formatter {
  constructor() {
    this.calls = new Map();   // callId → {name, ts}
    this.turn = null;
    this.step = null;
    this.lastEventTs = 0;
  }

  /** 返回 {i, t, lvl, text} 或 null（不值得显示的事件） */
  format(entry) {
    const { ord, ev } = entry;
    const d = ev.data || {};
    const t = ev.time || Date.now();
    this.lastEventTs = t;
    const mk = (lvl, text) => ({ i: ord, t, lvl, text });

    // 从任意事件里补齐「第几轮 / 第几步」——首屏只格式化尾巴时也能显示位置
    if (typeof d.turn === 'number') this.turn = d.turn;
    if (typeof d.step === 'number') this.step = d.step;

    switch (ev.type) {
      case 'turn/start':
        this.turn = d.turn; this.step = null;
        return mk('turn', `▶ 第 ${d.turn} 轮 开始`);
      case 'step/start':
        this.step = d.step;
        return mk('step', `· 第 ${d.turn}.${d.step} 步`);
      case 'step/end':
        return mk('dim', `· 第 ${d.turn}.${d.step} 步 结束`);
      case 'turn/end': {
        const kind = d.reason?.kind ?? '?';
        const dur = d.reason?.durationMs ? ` ${Math.round(d.reason.durationMs / 1000)}s` : '';
        return mk('turn', `⏹ 第 ${d.turn} 轮 结束（${kind}）${dur}`);
      }
      case 'assistant/message': {
        const parts = (d.message?.content || []).filter((c) => (c.type === 'reasoning' || c.type === 'text') && c.text);
        if (!parts.length) return null;
        return mk(parts.some((p) => p.type === 'text') ? 'say' : 'think',
          (parts.some((p) => p.type === 'text') ? '💬 ' : '💭 ') + clip(parts.map((p) => p.text).join(' ')));
      }
      case 'tool/call': {
        let args = d.arguments, obj = null;
        if (typeof args === 'string') { try { obj = JSON.parse(args); } catch { /* 非 JSON */ } }
        else if (args && typeof args === 'object') obj = args;
        let brief = '';
        if (obj) {
          for (const k of ['description', 'command', 'file_path', 'path', 'query', 'task', 'prompt', 'project', 'sessionId', 'url']) {
            if (typeof obj[k] === 'string' && obj[k].trim()) { brief = clip(firstLine(obj[k]), 120); break; }
          }
          if (!brief) for (const v of Object.values(obj)) if (typeof v === 'string' && v.trim()) { brief = clip(firstLine(v), 120); break; }
          if (!brief) brief = clip(JSON.stringify(obj), 100);
        } else if (args) brief = clip(String(args), 100);
        this.calls.set(d.callId, { name: d.name, ts: t });
        return mk('tool', `🔧 ${d.name}${brief ? '  ' + brief : ''}`);
      }
      case 'tool/result': {
        const callId = d.toolCallId || d.message?.source?.callId;
        const info = this.calls.get(callId);
        this.calls.delete(callId);
        const dur = info ? Math.round((t - info.ts) / 100) / 10 : null;
        const text = (d.message?.content || []).map((c) => c.text).filter(Boolean).join('\n');
        const bad = /^(error|Error|ERROR)[:\s]|\[exit code: [1-9]|Traceback|Exception/.test(text) || d.isError;
        return mk(bad ? 'err' : 'ok',
          `${bad ? '✖' : '✔'} ${info?.name ?? 'tool'}${dur != null ? ` ${dur}s` : ''}${text ? '  ' + clip(firstLine(text), 120) : ''}`);
      }
      case 'user/message': {
        const text = (d.content || []).map((c) => c.text).filter(Boolean).join('\n').trim();
        if (!text) return null;
        if (/^=====\s*长期记忆|^<system-reminder>|^\[Compressed conversation section\]|^可能相关的记忆，仅供参考|^Current runtime context\.|^Time sampled while preparing/.test(text)) return null;
        return mk('user', `👤 ${clip(firstLine(text), 120)}`);
      }
      case 'command/run':
        return mk('cmd', `⌘ /${d.name}${d.args || ''}`);
      case 'model/selection':
        return mk('meta', `⚙ 模型 ${d.provider}/${d.model}${d.reasoningEffort ? ' (' + d.reasoningEffort + ')' : ''}`);
      case 'session/title':
        return mk('meta', `📝 标题 ${clip(d.title, 80)}`);
      case 'hook/result':
        return d.decision && d.decision !== 'pass' ? mk('warn', `⚠ 钩子 ${d.point} → ${d.decision}`) : null;
      case 'todo/write': {
        const todos = d.todos || [];
        const done = todos.filter((x) => x.status === 'completed').length;
        return mk('meta', `☑ 待办 ${done}/${todos.length}`);
      }
      case 'job/settled': {
        if (d.toolCall) return null; // 前台调用已由 tool/result 展示
        const dur = d.startedAt && d.finishedAt ? Math.round((d.finishedAt - d.startedAt) / 1000) + 's' : '';
        return mk('meta', `🛠 后台任务 ${d.jobId} ${d.status || ''} ${dur}`);
      }
      default:
        return null;
    }
  }
}

/** 状态：给前端头部显示「第几轮、什么在跑、闲着多久」 */
export function buildStatus(formatter, pendingFromEvents = []) {
  const now = Date.now();
  const pending = pendingFromEvents.map((c) => ({ name: c.name, ms: now - c.ts }));
  return {
    turn: formatter.turn,
    step: formatter.step,
    idleMs: formatter.lastEventTs ? now - formatter.lastEventTs : 0,
    pending,
    names: [...new Set(pending.map((p) => p.name))],
  };
}

export { MAX_EVENTS, DEFAULT_BACKLOG };
