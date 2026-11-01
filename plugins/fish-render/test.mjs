// fish-render 单测：node plugins/fish-render/test.mjs
import { render, hash } from './index.js'
let fail = 0
const ok = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fail++ }
const base = { particleCut: 0, atKeep: 1, leadQuestionKeep: 1, punctFill: 0, ellipsisToComma: true, selfRefKeep: 1 }

ok('省略号换逗号', render('嗯…好吧', base, 1) === '嗯，好吧')
ok('句首省略号删掉', render('…行吧', base, 1) === '行吧')
ok('重复串语气词不动', render('哈哈哈', { ...base, particleCut: 1 }, 1) === '哈哈哈')
ok('句末语气词可删', render('好的呀', { ...base, particleCut: 1 }, 1) === '好的')
ok('括号动作最多一个', (render('行（点头）好（笑）', base, 1).match(/（/g) || []).length === 1)
ok('punctFill=1 补句号', render('知道了', { ...base, punctFill: 1 }, 1) === '知道了。')
ok('skipPunct 不补', render('知道了', { ...base, punctFill: 1, skipPunct: true }, 1) === '知道了')
ok('selfRefWord 留空不改', render('本喵不吃', { ...base, selfRefKeep: 0 }, 1) === '本喵不吃')
const sw = { ...base, selfRefWord: '本喵', selfRefKeep: 0 }
ok('keep=0 整条换', render('本喵不吃，本喵要睡', sw, 1) === '我不吃，我要睡')
ok('keep=1 不动', render('本喵不吃', { ...sw, selfRefKeep: 1 }, 1) === '本喵不吃')
let mixed = 0
for (let i = 0; i < 200; i++) {
  const r = render(`本喵第${i}次说，本喵就这样`, { ...sw, selfRefKeep: 0.35 }, hash('g' + i))
  if (r.includes('本喵') && r.includes('我')) mixed++
}
ok('按条抽签，不同条内混用', mixed === 0)
ok('同种子结果稳定', render('本喵吃饭呀', { ...sw, selfRefKeep: 0.5, particleCut: 0.5 }, 42) === render('本喵吃饭呀', { ...sw, selfRefKeep: 0.5, particleCut: 0.5 }, 42))
console.log(fail ? `\n失败 ${fail}` : '\n全过')
process.exitCode = fail ? 1 : 0
