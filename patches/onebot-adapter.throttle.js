// 插入位置①：kernel/onebot-adapter.js 里 `export class OneBotAdapter` 之前（需要文件顶部已有 import fs）

// ── 出站频率限流 + 打字延迟（配置来自 /root/.dsh/throttle.json，面板可改，3s 内热生效）──
// 文件不存在时回落到环境变量 / 内置默认值。对应 QQ 风控里的"发送频率异常"。
const THROTTLE_PATH = process.env.QQ_THROTTLE_FILE || '/root/.dsh/throttle.json'
const DEF_RATE = { enabled: true, perMinute: 12, perHour: 60, perDay: 300, minGapMs: 1500, maxWaitMs: 45000 }
const DEF_TYPING = { enabled: true, minMs: 3000, longAt: 100, longMs: 10000, perCharMs: 60, maxMs: 20000, jitter: 0.25 }
function _envJson(name) { try { return JSON.parse(process.env[name] || '{}') } catch { return {} } }
let _thr = { at: 0, rate: null, typing: null }
function loadThrottle() {
  if (Date.now() - _thr.at < 3000) return _thr
  let rate = { ...DEF_RATE, ..._envJson('QQ_SEND_RATE') }
  let typing = { ...DEF_TYPING, ..._envJson('QQ_TYPING_DELAY') }
  try {
    const j = JSON.parse(fs.readFileSync(THROTTLE_PATH, 'utf8'))
    if (j && typeof j === 'object') {
      if (j.rate) rate = { ...rate, ...j.rate }
      if (j.typing) typing = { ...typing, ...j.typing }
    }
  } catch { /* 文件不存在/坏了 → 用 env + 默认 */ }
  _thr = { at: Date.now(), rate, typing }
  return _thr
}
const _sentAt = []
function _prune(now) {
  const cut = now - 24 * 3600 * 1000
  while (_sentAt.length && _sentAt[0] < cut) _sentAt.shift()
}
function _rateWait(now, R) {
  if (!R.enabled) return 0
  _prune(now)
  const since = (ms) => _sentAt.filter((t) => now - t < ms)
  const m = since(60000), h = since(3600000), d = since(86400000)
  let wait = 0
  if (m.length >= R.perMinute) wait = Math.max(wait, 60000 - (now - m[0]) + 50)
  if (h.length >= R.perHour) wait = Math.max(wait, 3600000 - (now - h[0]) + 50)
  if (d.length >= R.perDay) wait = Math.max(wait, 86400000 - (now - d[0]) + 50)
  const last = _sentAt[_sentAt.length - 1]
  if (last != null) wait = Math.max(wait, last + R.minGapMs - now)
  return wait > 0 ? wait : 0
}
function typingDelayMs(text) {
  const T = loadThrottle().typing
  if (!T.enabled) return 0
  const plain = String(text ?? '').replace(/\[CQ:[^\]]+\]/g, '')
  const n = plain.length
  if (n === 0) return 0
  // 卡片接线（2026-10-31）：短句按 lognormal 采样（median/p90 来自生效卡），长文仍按字数递增
  if (T.dist === 'lognormal' && n < T.longAt && Number(T.medianMs) > 0) {
    const med = Number(T.medianMs), p90 = Math.max(med, Number(T.p90Ms) || med)
    const sigma = Math.log(p90 / med) / 1.2816
    let u = 0, v = 0
    while (u === 0) u = Math.random()
    while (v === 0) v = Math.random()
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
    return Math.round(Math.min(Number(T.maxMs) || 20000, Math.max(800, med * Math.exp(sigma * z))))
  }
  const base = n < T.longAt
    ? T.minMs
    : Math.min(T.maxMs, T.longMs + Math.max(0, n - T.longAt) * T.perCharMs)
  const j = 1 + (Math.random() * 2 - 1) * (T.jitter || 0)
  return Math.round(base * j)
}
async function acquireSendSlot(log) {
  const R = loadThrottle().rate
  if (!R.enabled) return
  for (let i = 0; i < 400; i++) {
    const now = Date.now()
    const wait = _rateWait(now, R)
    if (wait <= 0) { _sentAt.push(Date.now()); return }
    if (wait > R.maxWaitMs) {
      log?.warn?.(`出站频率超限，放弃本条（需等 ${Math.round(wait / 1000)}s）`)
      throw new Error(`出站频率限流：需等 ${Math.round(wait / 1000)}s`)
    }
    log?.debug?.(`出站限流，排队 ${Math.round(wait)}ms`)
    await new Promise((r) => setTimeout(r, Math.min(wait, 1000)))
  }
  throw new Error('出站频率限流：排队超时')
}


// 插入位置②：OneBotAdapter.sendMessage(chatKey, text, opts = {}) 函数体最开头
/*
    // 打字延迟：模拟人打字，短句 3s、长文按字数递增（见文件头 TYPING）
    if (!opts.skipTypingDelay) {
      const d = typingDelayMs(text)
      if (d > 0) {
        this.log?.debug?.(`打字延迟 ${d}ms（${String(text ?? '').length} 字）→ ${chatKey}`)
        await new Promise((r) => setTimeout(r, d))
      }
    }
    await acquireSendSlot(this.log)
*/
