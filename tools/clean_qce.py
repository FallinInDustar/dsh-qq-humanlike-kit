# QCE 群聊导出 → 清洗 + 疑似 bot 排查 + 真人基线 + bot 互动配对
# 只在本机跑；输出里 QQ 号一律换成哈希别名，不打印原号。
import json, glob, os, re, sys, hashlib, statistics, collections, math

HERE = os.path.dirname(os.path.abspath(__file__))
QCE = sys.argv[1] if len(sys.argv) > 1 else sys.exit("用法: python clean_qce.py <QCE chunked_jsonl 导出目录> [你自己的QQ号]")
SALT = os.environ.get("CORPUS_SALT", "change-me")   # 换成你自己的盐，别公开
CAP = 0.05                       # 单人最多占 5% 权重
SELF_UIN = sys.argv[2] if len(sys.argv) > 2 else ""   # 导出者本人，基线里排除


# 运行信息 / 指令：协议端状态回显（版本、平台、运行时长）、#指令、反代/模型名等，一律当噪声丢掉，
# 既不进基线也不进标注表（2026-11-01 用户指出标注表第 75 行暴露了 bot 的运行状态）。
# 只丢「机器产出」：状态回执、#指令、密钥样式串、错误码模板。真人聊到反代/NapCat/APIkey 是正常话题，保留。
NOISE = re.compile(r"SnowLuma\s*状态|版本[:：]\s*\d|平台[:：]\s*(win|linux|darwin)|运行时长[:：]|^#\S|^/v1|sk-[A-Za-z0-9]{3,}|各种错误代码含义", re.I)
def is_noise(t):
    return bool(t) and bool(NOISE.search(t))

def alias(uin):
    return "u" + hashlib.sha256((SALT + str(uin)).encode()).hexdigest()[:8]

# ---------- 读 QCE ----------
def load_qce(d):
    rows = []
    for f in sorted(glob.glob(os.path.join(d, "chunks", "*.jsonl"))):
        for l in open(f, encoding="utf-8"):
            if l.strip(): rows.append(json.loads(l))
    rows.sort(key=lambda r: r["timestamp"])
    out = []
    for r in rows:
        if r.get("system") or r.get("recalled"): continue
        els = r["content"]["elements"]
        s = r["sender"]
        text = "".join(e["data"].get("text", "") for e in els if e["type"] == "text")
        if is_noise(text): continue
        reply = next((e["data"] for e in els if e["type"] == "reply"), None)
        ats = [e["data"].get("uin") for e in els if e["type"] == "at" and (e["data"].get("atType") or 0) != 1]
        media = sum(e["type"] in ("image", "face", "market_face", "video") for e in els)
        out.append({
            "id": r["id"], "ts": r["timestamp"] / 1000, "uin": str(s.get("uin") or s.get("uid")),
            "name": s.get("groupCard") or s.get("name") or "",
            "text": text.strip(), "reply_to": str(reply["senderUin"]) if reply else None,
            "reply_mid": reply["referencedMessageId"] if reply else None,
            "ats": [str(a) for a in ats if a], "media": media,
            "forward": any(e["type"] == "forward" for e in els),
            "card": any(e["type"] in ("json", "wallet") for e in els),
        })
    return out

# ---------- 指标 ----------
END = set("。！？!?.~～…")
PART = set("呀啦嘛呗哦欸哈呢吧啊噢喔咯嗷")
def fold(t): return re.sub(r"(.)\1{2,}", r"\1", t)

def msg_feats(m):
    t = m["text"]
    f = {"pure_media": 1.0 if (not t and m["media"]) else 0.0}
    if not t: return f
    tf = fold(t)
    f.update({
        "len": len(t), "le3": 1.0 if len(t) <= 3 else 0.0,
        "endp": 1.0 if t[-1] in END else 0.0,
        "anyp": 1.0 if re.search(r"[，。！？,.!?、；;：:]", t) else 0.0,
        "ellip": 1.0 if re.search(r"…|\.{3}|。。", t) else 0.0,
        "brk": 1.0 if re.search(r"[（(][^）)]{1,15}[）)]", t) else 0.0,
        "tilde": 1.0 if re.search("[~～]", t) else 0.0,
        "q_lead": 1.0 if t[0] in "？?" else 0.0,
        "rep": 1.0 if re.search(r"(.)\1{2,}", t) else 0.0,
        "part": sum(c in PART for c in tf) / max(1, len(tf)),
        "at": 1.0 if m["ats"] else 0.0, "reply": 1.0 if m["reply_to"] else 0.0,
    })
    return f

def weighted_baseline(msgs, label):
    by = collections.defaultdict(list)
    for m in msgs: by[m["uin"]].append(m)
    N = len(msgs); cap = max(1, CAP * N)
    acc = collections.defaultdict(float); wsum = collections.defaultdict(float); lens = []
    for u, ms in by.items():
        w = min(len(ms), cap) / len(ms)
        for m in ms:
            f = msg_feats(m)
            for k, v in f.items():
                if k == "len": lens.append((v, w)); continue
                acc[k] += v * w; wsum[k] += w
    # 加权中位数
    lens.sort(); tot = sum(w for _, w in lens); c = 0; med = None
    for v, w in lens:
        c += w
        if c >= tot / 2: med = v; break
    # 连发：同一人 60 秒内连续 ≥2 条
    bursts = runs = 0; prev = None; cur = 0
    for m in msgs:
        if prev and m["uin"] == prev["uin"] and m["ts"] - prev["ts"] < 60: cur += 1
        else:
            if prev: runs += 1; bursts += cur >= 1
            cur = 0
        prev = m
    res = {"label": label, "msgs": N, "speakers": len(by),
           "speakers_ge20": sum(len(v) >= 20 for v in by.values()),
           "median_len": med, "burst_rate": round(bursts / max(1, runs), 3)}
    for k in acc: res[k] = round(acc[k] / wsum[k], 3)
    return res

# ---------- 疑似 bot ----------
def bot_scan(msgs):
    by = collections.defaultdict(list); idx = {}
    for i, m in enumerate(msgs): by[m["uin"]].append(i); idx[m["id"]] = i
    rows = []
    for u, ii in by.items():
        tm = [msgs[i] for i in ii if msgs[i]["text"]]
        if len(tm) < 30: continue
        # 被叫后快速回：本条是引用/@ 某人，且 60s 内那人刚 @/引用过自己
        fast = 0
        for i in ii:
            m = msgs[i]
            if not m["reply_to"]: continue
            for j in range(i - 1, max(-1, i - 40), -1):
                p = msgs[j]
                if m["ts"] - p["ts"] > 60: break
                if p["uin"] == m["reply_to"] and (u in p["ats"] or p["reply_to"] == u): fast += 1; break
        addressed = sum(1 for m in msgs if u in m["ats"] or m["reply_to"] == u)
        night = sum(1 for i in ii if 3 <= ((msgs[i]["ts"] / 3600 + 8) % 24) < 7)
        lens = [len(m["text"]) for m in tm]
        rows.append({
            "alias": alias(u), "n": len(ii),
            "endp": round(sum(m["text"][-1] in END for m in tm) / len(tm), 2),
            "reply": round(sum(bool(msgs[i]["reply_to"]) for i in ii) / len(ii), 2),
            "fast_reply": round(fast / len(ii), 2),
            "addressed_per_msg": round(addressed / len(ii), 2),
            "len_cv": round(statistics.pstdev(lens) / max(1, statistics.mean(lens)), 2),
            "night": round(night / len(ii), 3),
            "_uin": u,
        })
    for r in rows:   # 粗分：被叫即回 + 被叫多 → 强疑似；只是格式工整 → 弱疑似
        r["score"] = round(2 * r["fast_reply"] + min(1, r["addressed_per_msg"]) + r["endp"] * 0.5, 2)
    rows.sort(key=lambda r: -r["score"])
    return rows

# ---------- bot 互动配对 ----------
def pairs_for(msgs, bot_uin, limit=None):
    byid = {m["id"]: m for m in msgs}
    out = []
    for i, m in enumerate(msgs):
        if m["uin"] != bot_uin or not m["text"]: continue
        src = byid.get(m["reply_mid"]) if m.get("reply_mid") else None
        if not src:   # 退而求其次：60s 内最近一条叫她的
            for j in range(i - 1, max(-1, i - 30), -1):
                p = msgs[j]
                if m["ts"] - p["ts"] > 60: break
                if bot_uin in p["ats"] or p["reply_to"] == bot_uin: src = p; break
        if not src or src["uin"] == bot_uin: continue
        # 同一人与她的历史互动次数（到此刻为止）
        out.append({"ts": int(m["ts"]), "who": alias(src["uin"]),
                    "in": (src["text"] or ("[图/表情]" if src["media"] else "")), "out": m["text"],
                    "lag_s": round(m["ts"] - src["ts"], 1)})
    hist = collections.Counter()
    for p in out:
        hist[p["who"]] += 1; p["nth_with_this_person"] = hist[p["who"]]
    return out

def main():
    qce = load_qce(QCE)
    scan = bot_scan(qce)
    # 判据（2026-11-01 人工复核后收紧）：「被叫即回」占自己发言一半以上才算 bot。
    # 只看 addressed 会把「常跟 bot 聊的真人」误杀——bot 引用他们，他们的被叫数就高。
    strong = [r for r in scan if r["fast_reply"] >= 0.5]
    # 只是格式工整（句末标点高）不排除，标出来人工看
    weak = [r for r in scan if r not in strong and r["endp"] >= 0.6]
    exclude = {r["_uin"] for r in strong} | {SELF_UIN}
    human = [m for m in qce if m["uin"] not in exclude and not m["forward"] and not m["card"]]
    # 刷屏：同一人 10s 内重复同一句
    seen = {}; dedup = []
    for m in human:
        k = (m["uin"], m["text"])
        if m["text"] and k in seen and m["ts"] - seen[k] < 10: continue
        seen[k] = m["ts"]; dedup.append(m)
    base = [weighted_baseline(dedup, "真人基线")]
    for b in strong:   # 每只 bot 单列一行，当「别人家人设」参考，不进基线
        bm = [m for m in qce if m["uin"] == b["_uin"]]
        base.append(weighted_baseline(bm, f"bot参考:{b['alias']}"))
    od = os.path.join(HERE, "out"); os.makedirs(od, exist_ok=True)
    json.dump([{k: v for k, v in r.items() if k != "_uin"} for r in scan], open(os.path.join(od, "bot_scan.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    json.dump(base, open(os.path.join(od, "baseline.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    for b in strong:   # 每只 bot 的「谁说了什么 → 它怎么回」配对，用来做标注集
        pr = pairs_for(qce, b["_uin"])
        with open(os.path.join(od, f"bot_pairs_{b['alias']}.jsonl"), "w", encoding="utf-8") as f:
            for p in pr: f.write(json.dumps(p, ensure_ascii=False) + "\n")
    with open(os.path.join(od, "human_clean.jsonl"), "w", encoding="utf-8") as f:
        for m in dedup:
            f.write(json.dumps({"ts": int(m["ts"]), "who": alias(m["uin"]), "text": m["text"], "media": m["media"],
                                "at": [alias(a) for a in m["ats"]], "reply_to": alias(m["reply_to"]) if m["reply_to"] else None},
                               ensure_ascii=False) + "\n")
    print("strong", [(r["alias"], r["n"], r["fast_reply"], r["addressed_per_msg"]) for r in strong])
    print("weak", [(r["alias"], r["n"], r["endp"]) for r in weak])
    print("human kept", len(dedup), "of", len(qce))
    for b in base: print(json.dumps(b, ensure_ascii=False))

if __name__ == "__main__":
    main()
