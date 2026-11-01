// 两档切换 + 跨插件不补句号 单测
import { makeTracker, markProbed, isProbed } from './index.js'
import { render } from '../fish-render/index.js'

let fail = 0
const ok = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fail++ }
const cfg = { personLimit: 2, personWindowMin: 30, groupLimit: 4, groupWindowMin: 10 }
const M = 60000

{ // 同一人：1、2 岔开，3 起不耐烦
  const hit = makeTracker(); const t0 = 1e12
  const r = [0, 1, 2, 3].map((i) => hit('group:1', 'A', t0 + i * M, cfg).tier)
  ok('同一人 1/2 岔开 3/4 不耐烦', r.join() === 'light,light,annoyed,annoyed')
}
{ // 30 分钟没人再问就清零
  const hit = makeTracker(); const t0 = 1e12
  hit('group:1', 'A', t0, cfg); hit('group:1', 'A', t0 + M, cfg)
  ok('同一人隔 31 分钟清零', hit('group:1', 'A', t0 + 32 * M, cfg).tier === 'light')
}
{ // 接力：三个人各问一次不升，群内第 4 次升
  const hit = makeTracker(); const t0 = 1e12
  const r = ['A', 'B', 'C', 'D'].map((q, i) => hit('group:1', q, t0 + i * M, cfg).tier)
  ok('接力问：群内第 4 次升档', r.join() === 'light,light,light,annoyed')
}
{ // 群内窗口 10 分钟
  const hit = makeTracker(); const t0 = 1e12
  ;['A', 'B', 'C'].forEach((q, i) => hit('group:1', q, t0 + i * M, cfg))
  ok('群内隔 11 分钟不累计', hit('group:1', 'D', t0 + 13 * M, cfg).tier === 'light')
}
{ // 不同群互不影响
  const hit = makeTracker(); const t0 = 1e12
  hit('group:1', 'A', t0, cfg); hit('group:1', 'A', t0 + M, cfg)
  ok('不同群分开计数', hit('group:2', 'A', t0 + 2 * M, cfg).tier === 'light')
}
{ // 阈值可调
  const hit = makeTracker(); const t0 = 1e12
  ok('personLimit=0 首次即不耐烦', hit('group:1', 'A', t0, { ...cfg, personLimit: 0 }).tier === 'annoyed')
}
{ // 跨插件标记：fish-render 这轮不补句号
  const now = Date.now()
  markProbed('group:9', now)
  ok('标记生效', isProbed('group:9', now + 1000))
  ok('标记 2 分钟后过期', !isProbed('group:9', now + 121000))
  const base = { particleCut: 0, atKeep: 1, leadQuestionKeep: 1, punctFill: 1, ellipsisToComma: true, selfRefKeep: 1 }
  ok('平时 punctFill=1 会补句号', render('查什么查', base, 1).endsWith('。'))
  ok('被试探那轮不补', !render('查什么查', { ...base, skipPunct: true }, 1).endsWith('。'))
}
console.log(fail ? `\n失败 ${fail}` : '\n全过')
process.exitCode = fail ? 1 : 0
