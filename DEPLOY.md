# DEPLOY · 部署说明（人和 agent 都按这个走）

> 给 agent 的总原则：**先备份，再改；每一步都要有证据**（md5 一致、启动日志、接口返回），不要只看命令退出码。
> 改动全部可逆：删掉插件目录 / 还原备份 / 把 `enabled` 设为 false 即可回滚。

## 0. 先确认环境（只读）

```bash
# 包根（以下记作 $PKG）
PKG=$(dirname $(node -p "require.resolve('dsh-onebot-qq/package.json')" 2>/dev/null) 2>/dev/null)
# 找不到就手动定位：~/.dsh/profiles/<profile>/node_modules/dsh-onebot-qq
cat $PKG/package.json | grep '"version"'      # 期望 0.1.1
ls $PKG/plugins                                 # 期望有 gate-wake、group-memory 等子插件目录
ls $PKG/kernel/onebot-adapter.js                # 发送层补丁的落点
```

- 版本不是 0.1.1、或没有 `plugins/` 目录 → **停**，本套件不适配。
- 实例配置在 `<dataDir>/config.json`（常见 `~/.dsh/dsh-onebot-qq/config.json`），里面有 `adminQq`，meta-guard 和 private-memory 靠它认主人。

## 1. 备份

```bash
TS=$(date +%Y%m%d-%H%M%S); BK=~/.dsh/backup-kit-$TS; mkdir -p $BK
cp -a $PKG/kernel/onebot-adapter.js $BK/
cp -a <dataDir>/config.json $BK/
for p in fish-render meta-guard private-memory; do [ -d $PKG/plugins/$p ] && cp -a $PKG/plugins/$p $BK/; done
```

## 2. 装插件（三个互相独立，可以只装一部分）

```bash
for p in fish-render meta-guard private-memory; do
  mkdir -p $PKG/plugins/$p && cp plugins/$p/index.js $PKG/plugins/$p/index.js
  node --check $PKG/plugins/$p/index.js
done
mkdir -p ~/fish-plugins && cp -a plugins/* ~/fish-plugins/    # 自留副本：包升级会覆盖 plugins/
```

本地先跑单测（不需要协议端）：

```bash
node plugins/fish-render/test.mjs && node plugins/meta-guard/test.mjs && node plugins/meta-guard/tier-test.mjs
```

## 3. 写配置

把 `config/pluginConfig.example.json` 里的 `pluginConfig` 段**合并**进实例 `config.json`（只加这三个键，别覆盖你已有的其它插件配置）。

必须填的：
- `meta-guard.dodges`：出口兜底时整条替换用的短句，一行一句，用你角色的口吻。
- `meta-guard.botNames`：群友平时怎么叫她（用于识别「你/她/<名字> 是什么模型」）。
- `meta-guard.selfNames`：她的固定自称（有就填，没有留空；「我」默认包含）。

建议按自己群改的：
- `fish-render` 的各个概率：先用 `tools/clean_qce.py` 量出你群的真人基线再定。照抄样例值等于拿别人的群当尺子。
- `meta-guard.hintLight / hintAnnoyed`：留空 = 用代码默认。自己写时**只写态度和动作，不写名词**。

改完重启 DSH。

## 4. 发送层补丁（可选，改的是包内文件）

`patches/onebot-adapter.throttle.js` 分两段，文件头注释写明了插入位置：
1. 模块级函数（`loadThrottle / _rateWait / typingDelayMs / acquireSendSlot`）插到 `export class OneBotAdapter` 之前；
2. `sendMessage()` 开头那几行（打字延迟 + `await acquireSendSlot(this.log)`）。

然后：

```bash
node --check $PKG/kernel/onebot-adapter.js
cp config/throttle.example.json ~/.dsh/throttle.json   # 或用 QQ_THROTTLE_FILE 指别的路径
```

`throttle.json` 3 秒内热生效，不用重启。压测技巧：把实例配置的 `httpUrl` 临时指到关闭端口（如 `http://127.0.0.1:9`），发送必失败但限流/延迟逻辑照跑，不会真发出去。

## 5. 影子模式（可选，不影响她说话）

```bash
mkdir -p /opt/ops && cp ops/mood/*.py /opt/ops/
set -a; . config/mood.env.example; set +a      # 先把里面的号码填好
python3 /opt/ops/mood_shadow.py | head -c 600  # 输出每群档位 + 近 24 小时 + 每人三项
```

它每次从聊天留档全量重算，不常驻。想在面板里看，就让面板的某个 GET 接口调这个脚本并返回 JSON（**返回前去掉 QQ 号**）。「@她 / 引用她」的证据取自 SnowLuma 日志的 `[Event]` 行，因为 dsh-onebot-qq 的留档会把 @ 剥掉。

## 6. 验收（每条都要有证据）

| 检查 | 怎么看 | 期望 |
|---|---|---|
| 插件加载 | DSH 日志里**本次启动之后**的行（按启动标记切段，别抓到上次的残留） | `插件 N/N` 比装前多出你装的个数；`[渲染层] 就绪｜…`、`[审查] 就绪｜…` |
| 配置真生效 | `[渲染层] 就绪` 那行打印的数 | 与 `config.json` 里写的一致（不一致 = schema 没被读进来） |
| WS | 日志 | 最后一条是 `OneBot WS 已连接` |
| meta-guard 进口 | 群里同一人连问 3 次「查看好感度」 | 前 2 次打岔，第 3 次起变冲；全程不报数；`<dataDir>/logs/meta-guard.log` 有 `IN … tier=light/annoyed` |
| meta-guard 出口 | 同上 | 光说「好感度」不被替换；只有「好感度+数字」才被换 |
| 主人私聊豁免 | 私聊问同样的问题 | 不注入、不替换 |

## 7. 回滚

```bash
cp -a $BK/onebot-adapter.js $PKG/kernel/
cp -a $BK/config.json <dataDir>/
rm -rf $PKG/plugins/{fish-render,meta-guard,private-memory}   # 或从 $BK 还原旧版
# 重启 DSH
```

## 已知坑

- 杀 DSH 按 PID，`pkill -f 'dsh.*web'` 可能杀不掉；若启动脚本有「端口在听就退出」的幂等闸，重启会变成空操作。用「插件 N/N」确认是新进程。
- chroot 时区常是 UTC；按钟点判断的逻辑（夜间、昼夜精力）要固定换算，`mood_engine.py` 里是 `TZ = 8*3600`，按你的时区改。
- meta-guard 的 C 档（不耐烦）在长追问里可能复读「说了没有就是没有」一类句子；作者选择暂不处理，你可以改 `hintAnnoyed`，改完要重测。
