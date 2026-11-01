#!/usr/bin/env python3
# /opt/ops/mood_shadow.py —— 心情好感「影子模式」：只算不用，不碰发送路径，不调模型。
#
# 跑法：面板 GET /mood 时按需调用（同 probe.py），不常驻、不进守护。每次从留档全量重算，确定性。
# 被叫证据来自 snowluma.log 的 [Event]（qq_chat 留档会剥掉 @她）。snowluma.log 会轮转，
# 所以每次把解析到的「被叫消息 ID」并进 ADDR_CACHE，旧的不丢。
#
# 输出 JSON：每群当前档位 + 近 24 小时逐时档位 + 每人三项与意愿。模型看不到这里任何东西。
import json, os, re, sys, glob, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mood_engine as M

CHAT_DIR = os.environ.get("MOOD_CHAT_DIR", "/root/.dsh/dsh-onebot-qq/logs/qq_chat")
SNOW_LOG = os.environ.get("MOOD_SNOW_LOG", "/root/snowluma.log")
OPS_DIR = os.environ.get("MOOD_OPS_DIR", "/root/.dsh/ops")
ADDR_CACHE = os.path.join(OPS_DIR, "mood-addressed.json")
OUT_FILE = os.path.join(OPS_DIR, "mood.json")
# 群里别家 bot 的 QQ 号（逗号分隔）：只算结构信号、权重 0.3、不判语气
BOTS = {int(x) for x in os.environ.get("MOOD_OTHER_BOTS", "").split(",") if x.strip().isdigit()}

ANSI = re.compile(r"\x1b\[[0-9;]*m")
EV = re.compile(r"\[Event\] 群 \[[^\]]*\((\d+)\)\] \| \[[^\]]*\((\d+)\)\]: ID:(-?\d+) (.*)")


def load_addressed():
    try:
        cache = {str(k): bool(v) for k, v in json.load(open(ADDR_CACHE, encoding="utf-8")).items()}
    except Exception:
        cache = {}
    if os.path.exists(SNOW_LOG):
        for l in open(SNOW_LOG, encoding="utf-8", errors="replace"):
            m = EV.search(ANSI.sub("", l))
            if not m: continue
            body = m.group(4)
            hit = (f"@{M.FISH}" in body) or bool(re.search(rf"\[回复 \[[^\]]*\({M.FISH}\)\]", body))
            key = f"{m.group(1)}:{m.group(3)}"
            if hit or key not in cache: cache[key] = hit
    try:
        tmp = ADDR_CACHE + ".tmp"
        json.dump(cache, open(tmp, "w", encoding="utf-8"))
        os.replace(tmp, ADDR_CACHE)
    except Exception:
        pass
    return cache


def run(now=None):
    addressed = load_addressed()
    eng = M.Engine(bots=BOTS)
    groups, names, n_addr = {}, {}, {}
    for f in sorted(glob.glob(os.path.join(CHAT_DIR, "group_*.jsonl"))):
        gid = int(re.search(r"group_(\d+)", f).group(1))
        rows = []
        for l in open(f, encoding="utf-8", errors="replace"):
            try: rows.append(json.loads(l))
            except Exception: pass
        rows.sort(key=lambda r: r.get("ts", 0))
        groups[gid] = rows
    now = now or time.time()
    out = {"ok": True, "mode": "shadow", "generated": int(now), "groups": []}
    for gid, rows in groups.items():
        hourly, next_h = [], None
        for r in rows:
            ts = r.get("ts", 0) / 1000
            if next_h is None: next_h = ts - ts % 3600 + 3600
            while ts >= next_h:
                hourly.append((int(next_h), eng.view(gid, None, next_h))); next_h += 3600
            if r.get("dir") == "out":
                eng.on_message(gid, ts, M.FISH, outbound=True); continue
            s = r.get("sender") or {}
            qq = s.get("qq")
            if qq: names[qq] = s.get("card") or s.get("name") or str(qq)
            a = addressed.get(f"{gid}:{r.get('messageId')}", False)
            if a: n_addr[(gid, qq)] = n_addr.get((gid, qq), 0) + 1
            eng.on_message(gid, ts, qq, addressed=a)
        while next_h is not None and next_h <= now:
            hourly.append((int(next_h), eng.view(gid, None, next_h))); next_h += 3600
        cur = eng.view(gid, None, now)
        people = []
        for (g, qq) in list(eng.people):
            if g != gid: continue
            v = eng.view(gid, qq, now)
            people.append({"qq": qq, "name": names.get(qq, str(qq)),
                           "tag": "主人" if qq == M.OWNER else ("bot" if qq in BOTS else "群友"),
                           "addressed": n_addr.get((gid, qq), 0), **v})
        people.sort(key=lambda p: -p["close"])
        out["groups"].append({
            "gid": gid, "msgs": len(rows), "now": cur,
            "last24": [{"t": t, "attitude": v["attitude"], "p": v["p"], "a": v["a"]} for t, v in hourly[-24:]],
            "people": people[:20],
            "recent": [{"t": int(t), "who": names.get(q, "") if q else "", "why": w, "v": v}
                       for t, g, q, w, v in eng.trace if g == gid][-12:],
        })
    try:
        tmp = OUT_FILE + ".tmp"
        json.dump(out, open(tmp, "w", encoding="utf-8"), ensure_ascii=False)
        os.replace(tmp, OUT_FILE)
    except Exception:
        pass
    return out


if __name__ == "__main__":
    print(json.dumps(run(), ensure_ascii=False))
