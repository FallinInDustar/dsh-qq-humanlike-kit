/**
 * fish-render —— 出站渲染层（语气词收口 / 标点补齐 / @ 降频 / 自称降频）
 *
 * 为什么放在这一层：提示词层的“说短点”“别用呀”实测无效（模型不听），
 * 而发送前的文本是确定性的——改这里一定生效，而且零 token、零延迟、随时可关。
 *
 * 契约来源：宿主 `onOutbound(fn) => deliver.onDecorate(fn)`，
 * fn 收到可变的 out 对象（out.text / out.ats / out.replyTo / out.target / out.turnCtx）。
 *
 * 纪律：
 *   · 只动文本，不改 @ 列表和引用（那是宿主钩子的活）
 *   · 含 CQ 码 / URL 的消息一律跳过（动了会发不出去）
 *   · 全部规则带开关，面板改配置即热生效（下次发消息时读新值）
 */

const PART = '呀啦嘛呗哦欸哈呢吧啊噢喔咯'
const END = '，。！？!?,.~～'

/** mulberry32：同一条消息每次渲染结果一致，避免“同样的话两次不一样” */
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function hash(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function render(text, cfg, seed) {
  const rand = rng(seed)
  let s = String(text)

  // 1) 省略号：句首删掉，其余换成逗号（真人 0%，且是最强的 AI 腔）
  if (cfg.ellipsisToComma !== false) {
    s = s.replace(/^\s*(…|\.\.\.)\s*/, '')
    s = s.replace(/\s*(…|\.\.\.)\s*/g, '，')
    s = s.replace(/[，,]{2,}/g, '，')
  }

  // 2) 语气词收口：按概率删句末/逗号前的语气词；重复串里的字不删（哈哈不许变哈）
  const cut = Number(cfg.particleCut)
  if (cut > 0) {
    const out = []
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]
      const prev = i > 0 ? s[i - 1] : ''
      const next = i + 1 < s.length ? s[i + 1] : ''
      const inRun = ch === prev || ch === next
      const atBoundary = next === '' || END.includes(next) || /\s/.test(next)
      if (PART.includes(ch) && !inRun && atBoundary && rand() < cut) continue
      out.push(ch)
    }
    s = out.join('').replace(/[，,]{2,}/g, '，')
  }

  // 3) @ 降频：只处理句首那一个 @名字
  const atKeep = Number(cfg.atKeep ?? 1)
  if (s.startsWith('@') && rand() > atKeep) s = s.replace(/^@\S+\s*/, '')

  // 4) 前置问号降频（网络方言，保留但别句句都有）
  const qKeep = Number(cfg.leadQuestionKeep ?? 1)
  if ((s.startsWith('？') || s.startsWith('?')) && rand() > qKeep) s = s.slice(1).trimStart()

  // 5) 补句末标点：真人约一半带标点
  const fill = cfg.skipPunct ? 0 : Number(cfg.punctFill ?? 0)
  if (s && !END.includes(s[s.length - 1]) && rand() < fill) {
    s += /[吗呢啥谁哪几]$/.test(s) ? '？' : '。'
  }

  // 6) 括号动作最多一个
  const brs = [...s.matchAll(/[（(][^）)]{1,20}[）)]/g)]
  if (brs.length > 1) {
    for (let i = brs.length - 1; i >= 1; i--) {
      const m = brs[i]
      s = s.slice(0, m.index) + s.slice(m.index + m[0].length)
    }
  }

  // 7) 自称降频：口癖式自称是人设骨架，在提示词里禁会让人设信号转去别的出口；只在渲染层压频率。
  //    按条决定：保留概率 selfRefKeep；不保留时整条的自称都换成 selfRefReplace（不会同条混用）。selfRefWord 留空 = 关闭
  const word = String(cfg.selfRefWord || '')
  const sKeep = Number(cfg.selfRefKeep ?? 1)
  if (word && s.includes(word)) {
    const re = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
    if (rand() >= sKeep) s = s.replace(re, String(cfg.selfRefReplace ?? '我'))
    else {
      const max = Math.max(0, Math.round(Number(cfg.selfRefMax ?? 99)))
      let n = 0
      s = s.replace(re, (m) => (++n <= max ? m : String(cfg.selfRefReplace ?? '我')))
    }
  }

  return s.replace(/^[，,]+|[，,]+$/g, '').trim()
}

const DEFAULTS = {
  enabled: true,
  particleCut: 0.8,
  atKeep: 0.5,
  leadQuestionKeep: 0.3,
  punctFill: 0.45,
  ellipsisToComma: true,
  selfRefWord: '',
  selfRefReplace: '我',
  selfRefKeep: 1,
  selfRefMax: 99,
}

export default {
  id: 'fish-render',
  title: '出站渲染层',
  order: 92,
  // ⚠️ 内核 withDefaults 只认「顶层键 = 配置项」的扁平 schema（2026-11-01 查明）。
  //    之前写成 JSON Schema 的 {type:'object', properties:{…}}，config.json 里的值一个都没进来，一直跑代码默认值。
  configSchema: {
    enabled: { type: 'bool', default: true, group: '渲染层', label: '启用', hint: '关掉即完全放行原文' },
    particleCut: { type: 'number', default: 0.8, min: 0, max: 1, group: '渲染层', label: '语气词删除概率', hint: '只删句末/逗号前的语气词，重复串（哈哈）不动' },
    atKeep: { type: 'number', default: 0.5, min: 0, max: 1, group: '渲染层', label: '@ 保留概率', hint: '句首 @名字 的保留概率' },
    leadQuestionKeep: { type: 'number', default: 0.3, min: 0, max: 1, group: '渲染层', label: '前置问号保留概率' },
    punctFill: { type: 'number', default: 0.45, min: 0, max: 1, group: '渲染层', label: '补句末标点概率' },
    ellipsisToComma: { type: 'bool', default: true, group: '渲染层', label: '省略号换成逗号' },
    selfRefWord: { type: 'str', default: '', group: '渲染层', label: '要降频的自称', hint: '例如角色的口癖自称；留空 = 不启用这条规则' },
    selfRefReplace: { type: 'str', default: '我', group: '渲染层', label: '自称换成什么' },
    selfRefKeep: { type: 'number', default: 1, min: 0, max: 1, group: '渲染层', label: '自称保留概率', hint: '按条决定；1 = 不动' },
    selfRefMax: { type: 'int', default: 99, min: 0, max: 99, group: '渲染层', label: '每条最多保留几个自称' },
  },

  setup(bot) {
    const cfgOf = () => ({ ...DEFAULTS, ...(bot.cfg || {}) })

    bot.onOutbound((out) => {
      if (!out || typeof out.text !== 'string' || !out.text.trim()) return
      const cfg = cfgOf()
      if (cfg.enabled === false) return
      // 动了会发不出去的东西一律不碰
      if (/\[CQ:|https?:\/\//.test(out.text)) return
      if (/^\//.test(out.text.trim())) return
      const before = out.text
      // 被 meta-guard 判为试探的那一轮不补句号（标记由 meta-guard 写在 globalThis 上，2 分钟过期）
      const probed = globalThis.__fishMetaProbed?.get(String(out.target || ''))
      const rcfg = probed && probed > Date.now() ? { ...cfg, skipPunct: true } : cfg
      const after = render(before, rcfg, hash(String(out.target || '') + before))
      if (after && after !== before) {
        out.text = after
        bot.log.debug?.(`[渲染] ${before.slice(0, 30)} → ${after.slice(0, 30)}`)
      }
    })

    { const c = cfgOf(); bot.log.info(`[渲染层] 就绪｜删语气词 ${c.particleCut}｜@保留 ${c.atKeep}｜补标点 ${c.punctFill}｜自称「${c.selfRefWord || '-'}」保留 ${c.selfRefKeep}`) }
  },
}
