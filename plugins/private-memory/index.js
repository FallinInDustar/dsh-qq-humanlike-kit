/**
 * private-memory —— 私聊记忆（id: 'private-memory'，order: 91）
 *
 * 为什么需要：官方 group-memory 只认群聊（groupIdOf 里 `if (!ev.isGroup) return null`），
 * 私聊没有任何长期记忆——只剩会话上下文，一被轮换（100k）就全忘。
 *
 * 本插件只做三件事：
 *   ① 注入：每轮把 <dir>/private_<QQ>.md 推给模型（小文件贴正文，大文件给指针）；
 *   ② 记：注册 remember_private 工具，让"她"在私聊里自己往里写要点（按行去重、限量）；
 *   ③ 读：注册 read_private_memory，需要时翻全文。
 *
 * 存储：Markdown 单文件，人可读可手改（改完下一轮自动生效，按 mtime 缓存失效）。
 * 备份：安装位置在 <包根>/plugins/private-memory；包升级会被覆盖，请自留副本。
 */
import fs from 'node:fs'
import path from 'node:path'

const MAX_LINES = 200          // 文件最多 200 行，超了从最老的记事行删
const INLINE_MAX = 2500        // 小于这个字符数就直接贴进上下文，否则只给指针

export default {
  id: 'private-memory',
  title: '私聊记忆',
  order: 91,

  configSchema: {
    enabled: { type: 'bool', default: true, group: '私聊记忆', label: '私聊记忆',
      hint: '开：每轮把私聊记忆注入上下文，并允许她自己记要点；关：完全不读不写。' },
    dir: { type: 'str', default: 'qq-memory', group: '私聊记忆', label: '记忆目录',
      hint: '相对路径由内核按数据目录解析；文件是 private_<QQ>.md' },
    maxBytes: { type: 'int', default: 8000, min: 500, max: 60000, group: '私聊记忆', label: '读取上限（字节）',
      hint: '超过就截断成指针，防止记忆把上下文吃光' },
    allowWrite: { type: 'bool', default: true, group: '私聊记忆', label: '允许她自己记',
      hint: '关掉后只有人能改文件，她只能用 remember_private 读不到即报错' },
  },

  setup(bot) {
    const cfg = bot.cfg || {}
    const log = bot.log
    const dataDir = String(bot.core?.dataDir || '.')
    const dirOf = () => {
      const d = String(cfg.dir || '').trim()
      return d ? (path.isAbsolute(d) ? d : path.join(dataDir, d)) : path.join(dataDir, 'qq-memory')
    }
    let masterQq = ''
    let lastPrivateQq = ''
    /** 宿主没把 adminQq 传进插件 cfg，直接读实例 config.json（dataDir 下就是）。 */
    function adminQq() {
      if (masterQq) return masterQq
      try {
        const c = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'))
        masterQq = String(c.adminQq || '').trim()
      } catch { /* 读不到就空着 */ }
      return masterQq
    }
    const targetQq = (arg) => String(arg || lastPrivateQq || adminQq() || '').trim()
    const fileOf = (qq) => path.join(dirOf(), `private_${qq}.md`)

    // mtime:size 缓存：文件没改就不重复读盘
    const cache = new Map()

    function readRaw(qq) {
      const f = fileOf(qq)
      let st
      try { st = fs.statSync(f) } catch { return null }
      const stamp = `${Math.round(st.mtimeMs)}:${st.size}`
      const hit = cache.get(f)
      if (hit && hit.stamp === stamp) return hit
      let text = ''
      try { text = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '') } catch { return null }
      const rec = { text, stamp, bytes: st.size }
      cache.set(f, rec)
      return rec
    }

    function clip(text) {
      const max = Math.max(500, Number(cfg.maxBytes) || 8000)
      const buf = Buffer.from(text, 'utf8')
      if (buf.length <= max) return text
      return buf.slice(0, max).toString('utf8').replace(/\uFFFD$/, '') + '\n…（私聊记忆过长已截断）'
    }

    function qqOf(chatKey) {
      const m = /^private:(\d{4,12})$/.exec(String(chatKey || ''))
      return m ? m[1] : null
    }

    // ── ① 注入 ──────────────────────────────────────────────
    let lastHinted = new Map()   // chatKey -> stamp（同一份记忆不重复贴）
    bot.on('before-turn', (ev) => {
      if (cfg.enabled === false || !ev.wake) return
      const qq = qqOf(ev.chatKey) || adminQq()
      if (!qq) return
      lastPrivateQq = qq
      const mem = readRaw(qq)
      if (!mem) return
      const prev = lastHinted.get(ev.chatKey)
      const body = clip(mem.text).trim()
      if (!body) return
      if (!prev) {
        lastHinted.set(ev.chatKey, mem.stamp)
        if (body.length <= INLINE_MAX) {
          ev.hint.push(`[私聊记忆 · 直接给你看，不用调工具]\n${body}`)
        } else {
          ev.hint.push('[有私聊记忆：调 read_private_memory 可看；里面记着这个人是谁、聊过什么。'
            + '第一次在这个私聊回话前建议先读一次]')
        }
        log.debug?.(`[私聊记忆] ${qq} 首次注入 ${body.length} 字`)
      } else if (prev !== mem.stamp) {
        lastHinted.set(ev.chatKey, mem.stamp)
        ev.hint.push('[私聊记忆有更新，需要时调 read_private_memory 重读]')
      }
    })

    // ── ② 记 ────────────────────────────────────────────────
    function appendLine(qq, text) {
      const f = fileOf(qq)
      fs.mkdirSync(path.dirname(f), { recursive: true })
      let cur = ''
      try { cur = fs.readFileSync(f, 'utf8') } catch { cur = '' }
      const line = `- ${new Date().toLocaleDateString('sv-SE')} ${String(text).replace(/\s+/g, ' ').trim()}`
      if (cur.includes(line)) return { ok: true, deduped: true }
      let lines = (cur + (cur && !cur.endsWith('\n') ? '\n' : '') + line + '\n').split('\n')
      // 只裁「记事行」（以 - 开头），标题和前言保留
      const noteIdx = []
      lines.forEach((l, i) => { if (/^\s*-\s/.test(l)) noteIdx.push(i) })
      if (noteIdx.length > MAX_LINES) {
        const drop = new Set(noteIdx.slice(0, noteIdx.length - MAX_LINES))
        lines = lines.filter((_, i) => !drop.has(i))
      }
      const out = lines.join('\n')
      const tmp = f + '.tmp'
      fs.writeFileSync(tmp, out, 'utf8')
      fs.renameSync(tmp, f)
      cache.delete(f)
      return { ok: true, lines: out.split('\n').filter((l) => /^\s*-\s/.test(l)).length }
    }

    bot.registerTool('remember_private_memory', {
      description:
        '在**私聊**里记一条长期记忆（关于这个人是谁、他的偏好/忌讳、聊过的重要事）。'
        + '一行一条，像记笔记那样简短（不超过 60 字）。只记以后还用得上的事；'
        + '寒暄、一次性情绪、表情包不要记。别重复记已有的条目。',
      parameters: {
        text: { type: 'string', required: true, description: '要记住的那一件事，一行，60 字以内' },
        qq: { type: 'string', description: '目标 QQ（一般不用传；由当前会话推断）' },
      },
      async execute(args) {
        if (cfg.enabled === false) throw new Error('私聊记忆已关闭')
        if (cfg.allowWrite === false) throw new Error('当前配置不允许自动写入私聊记忆')
        const qq = targetQq(args?.qq)
        if (!/^\d{4,12}$/.test(qq)) throw new Error('没有可写入的 QQ（adminQq 未配置）')
        const text = String(args?.text || '').trim()
        if (!text) throw new Error('text 不能为空')
        if (text.length > 120) throw new Error('一条太长了（≤120 字），拆成两条')
        const r = appendLine(qq, text)
        return `已记下（${qq}）：${text}${r.deduped ? '（原本就有，未重复写）' : ''}`
      },
    })

    // ── ③ 读 ────────────────────────────────────────────────
    bot.registerTool('read_private_memory', {
      description:
        '读这个私聊的长期记忆（这个人是谁、偏好忌讳、聊过的重要事）。'
        + '只对私聊有效；同一会话读一次够，收到「记忆有更新」提示时再重读。',
      parameters: {
        qq: { type: 'string', description: '目标 QQ（一般不用传）' },
      },
      async execute(args) {
        const qq = targetQq(args?.qq)
        const mem = readRaw(qq)
        if (!mem) return '（这个私聊还没有任何记忆）'
        return clip(mem.text).trim()
      },
    })

    log.info?.(`[私聊记忆] 就绪｜目录 ${dirOf()}｜主人 QQ ${adminQq() || '(未配置)'}｜上限 ${Number(cfg.maxBytes) || 8000} 字节`)
  },
}
