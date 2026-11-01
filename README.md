# dsh-qq-humanlike-kit

vibe coding产物，由dsv4.1f搭建框架，claude opus5.5完成优化、细节调整与收尾

这是一个给跑在 **DSH + dsh-onebot-qq + SnowLuma** 上的 QQ 群 AI 用的一套「人味 + 防露馅 + 情绪」组件。

> 来源：一次真实养成实践的复盘（见同仓库 `README.md` 实践记录）。数字是我自己在群里调整出来的，**留空配置项，不合口味记得自己调整**。
> 第三方 QQ 协议端违反 QQ 用户协议，有封号风险，建议小号，不过这是AI群友的通病了。

## 里面有什么

| 路径                                   | 是什么                                                     | 改不改线上行为           |
| ------------------------------------ | ------------------------------------------------------- | ----------------- |
| `plugins/fish-render/`               | 出站渲染层：省略号→逗号、语气词收口、@ 降频、补句末标点、括号动作限一个、固定自称降频            | 改（确定性、0 token、可关） |
| `plugins/meta-guard/`                | 试探审查：进口两档态度提示（岔开 → 不耐烦）+ 出口只拦「数值词+具体数」「自述内部」            | 改                 |
| `plugins/private-memory/`            | 私聊长期记忆（官方 group-memory 不管私聊）                            | 改                 |
| `patches/onebot-adapter.throttle.js` | 发送层补丁：出站限流 + 打字延迟（含 lognormal），读 `throttle.json` 3 秒热生效 | 改                 |
| `ops/mood/`                          | 心情/好感**影子模式**计算器：只算不用，不调模型、不碰发送路径                       | 不改                |
| `tools/clean_qce.py`                 | QQ Chat Exporter 导出 → 清洗、疑似 bot 排查、真人基线                 | 离线工具              |
| `config/*.example*`                  | 配置样例（`【】` 处要填）                                          | —                 |
| `persona/persona.template.md`        | 人设骨架（只有结构，内容全空）                                         | —                 |

## 前提

- dsh-onebot-qq **0.1.1**（`YUsaltyfish/dsh-onebot-qq`）。npm 上的 `dsh-onebot-qq@0.9.x` 是另一个仓库、没有包内 `plugins/` 目录，本套插件装不上去。
- Node ≥ 22（插件 / 测试），Python ≥ 3.10 标准库（ops / tools）。
- 子插件放在 `<dsh-onebot-qq 包根>/plugins/<id>/index.js`，**目录名必须等于插件 id**。

## 部署

给人看的步骤和给 agent 的检查清单都在 [`DEPLOY.md`](DEPLOY.md)。可以直接把这个仓库扔给你的 agent，让它按 `DEPLOY.md` 执行。


## 许可

本套件自写部分（fish-render / meta-guard / private-memory / ops / tools）按仓库根 LICENSE。
`patches/onebot-adapter.throttle.js` 是对 dsh-onebot-qq（BSD 3-Clause）`kernel/onebot-adapter.js` 的补丁片段，使用时请保留上游许可声明。
