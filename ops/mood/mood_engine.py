# 心情 / 好感 旁路计算器（影子模式：只算不用）
# 纯标准库，chroot 里的 python3 能直接跑。模型永远看不到这里的数，只会拿到一个档位名。
# 设计依据：docs/心情好感-机制设计.md（调侃为主不扣分、复合敌意半扣、只记被叫的那句）
import math, collections

import os
FISH = int(os.environ.get("MOOD_BOT_QQ", "0") or 0)      # 你的 bot QQ 号
OWNER = int(os.environ.get("MOOD_OWNER_QQ", "0") or 0)   # 主人 QQ 号（永远不会被判「懒得回」）
TZ = 8 * 3600                      # chroot 是 UTC，钟点一律固定 +8

DEFAULTS = {
    "hl_pos_min": 45,     # 愉悦偏正回基线半衰期
    "hl_neg_min": 150,    # 偏负（难过留得久）
    "hl_irr_min": 35,     # 对某人的烦躁
    "hl_energy_min": 60,  # 精力向昼夜基线回归
    "close_tau_days": 7,  # 亲近：每条因子按 exp(-Δt/7天) 衰减
    "energy_day": 0.7, "energy_night": 0.2, "night": (23.5, 7.0),
    "bot_weight": 0.3,    # bot 成员只算结构信号，且打折
    "cap_struct_per_day": 5, "cap_tone_per_day": 6,
    "pickup_s": 120,      # 她说完 2 分钟内被接
    "ignored_s": 600, "ignored_p": 0.05,
    "anger_max_min": 60,  # 愤怒最长持续，到点强制回落
    "tone_min_conf": 0.7, "neg_x": 2.0,
    "fam_idle_days": 30, "fam_floor": 3,
}
LABELS = ["夸", "调侃", "真敌意", "投喂", "提问", "其它"]
# label -> (亲近, 群愉悦, 对此人烦躁)
TONE = {"夸": (2.0, 0.15, 0.0), "投喂": (2.0, 0.20, 0.0), "提问": (0.5, 0.02, 0.0),
        "调侃": (0.0, 0.03, 0.0), "其它": (0.0, 0.0, 0.0), "真敌意": (-1.5, -0.10, 0.40)}


def local_hour(ts): return ((ts + TZ) / 3600) % 24
def local_day(ts): return int((ts + TZ) // 86400)
def toward(x, target, dt, hl): return target + (x - target) * 0.5 ** (dt / hl)
def clamp(x, lo, hi): return max(lo, min(hi, x))


class Engine:
    def __init__(self, bots=(), owner=OWNER, params=None):
        self.P = dict(DEFAULTS, **(params or {}))
        self.bots, self.owner = set(bots), owner
        self.groups, self.people = {}, {}
        self.daily = collections.defaultdict(float)
        self.trace = []                       # 因子流水：(ts, gid, qq, 原因, 值)

    # ---------- 群心情 ----------
    def _energy_base(self, ts):
        h = local_hour(ts); s, e = self.P["night"]
        return self.P["energy_night"] if (h >= s or h < e) else self.P["energy_day"]

    def _g(self, gid, ts):
        g = self.groups.get(gid)
        if g is None:
            g = self.groups[gid] = {"p": 0.0, "a": self._energy_base(ts), "t": ts,
                                    "pending": [], "anger_since": None}
        return g

    def advance(self, gid, ts):
        g = self._g(gid, ts)
        for o in [o for o in g["pending"] if ts - o >= self.P["ignored_s"]]:
            g["pending"].remove(o)                         # 她说完 10 分钟没人接（只动心情，不记人头）
            g["p"] = clamp(g["p"] - self.P["ignored_p"], -1, 1)
            self._tr(o + self.P["ignored_s"], gid, None, "说完没人接", -self.P["ignored_p"])
        t = g["t"]
        while t < ts:                                      # 10 分钟一步，跟得上昼夜基线
            step = min(600, ts - t)
            hl = self.P["hl_pos_min"] if g["p"] > 0 else self.P["hl_neg_min"]
            g["p"] = toward(g["p"], 0.0, step, hl * 60)
            g["a"] = toward(g["a"], self._energy_base(t + step), step, self.P["hl_energy_min"] * 60)
            t += step
        g["t"] = max(g["t"], ts)
        if g["p"] < -0.6:                                  # 愤怒强制回落，防「越逗越气」
            if g["anger_since"] is None: g["anger_since"] = ts
            elif ts - g["anger_since"] > self.P["anger_max_min"] * 60:
                g["p"], g["anger_since"] = -0.55, None
                self._tr(ts, gid, None, "愤怒到点回落", 0)
        else:
            g["anger_since"] = None
        return g

    # ---------- 对人关系 ----------
    def _person(self, gid, qq):
        k = (gid, qq)
        if k not in self.people:
            self.people[k] = {"days": set(), "ev": [], "irr": 0.0, "irr_t": 0, "last_addr": 0}
        return self.people[k]

    def _capped(self, gid, qq, kind, ts, v):
        cap = self.P["cap_struct_per_day"] if kind == "struct" else self.P["cap_tone_per_day"]
        key = (gid, qq, kind, local_day(ts), v >= 0)
        room = max(0.0, cap - self.daily[key])
        v2 = math.copysign(min(abs(v), room), v)
        self.daily[key] += abs(v2)
        return v2

    def _close(self, gid, qq, ts, v, kind, why):
        v = self._capped(gid, qq, kind, ts, v)
        if v:
            self._person(gid, qq)["ev"].append((ts, v)); self._tr(ts, gid, qq, why, v)
        return v

    def _irr(self, per, ts):
        return toward(per["irr"], 0.0, max(0, ts - per["irr_t"]), self.P["hl_irr_min"] * 60)

    def _tr(self, ts, gid, qq, why, v):
        self.trace.append((ts, gid, qq, why, round(v, 3)))

    # ---------- 事件入口 ----------
    def on_message(self, gid, ts, qq, addressed=False, outbound=False):
        g = self.advance(gid, ts)
        if outbound:
            g["pending"].append(ts); return
        if not addressed:
            # 小群里接话多半不 @（回放实测：只认 @/引用会把 63/73 次发言判成「没人接」，冷场把她逼到愤怒）。
            # 所以任何真人在 2 分钟内说话都算「有人接」，只给群心情一点甜头，不记到人头上。
            if qq not in self.bots and any(ts - o <= self.P["pickup_s"] for o in g["pending"]):
                g["pending"] = []
                g["p"] = clamp(g["p"] + 0.03, -1, 1)
            return                                          # 泛泛群聊不动个人关系
        w = self.P["bot_weight"] if qq in self.bots else 1.0
        per = self._person(gid, qq)
        d = local_day(ts)
        if d not in per["days"]:
            per["days"].add(d); self._tr(ts, gid, qq, "新互动日", 1)
        per["last_addr"] = ts
        picked = [o for o in g["pending"] if ts - o <= self.P["pickup_s"]]
        g["pending"] = []                                   # 有人叫她，就不算没人接
        if picked:
            self._close(gid, qq, ts, 1.0 * w, "struct", "接她的话")
            g["p"] = clamp(g["p"] + 0.1 * w, -1, 1)
        self._close(gid, qq, ts, 1.0 * w, "struct", "叫她")
        g["a"] = clamp(g["a"] + 0.1 * w, 0, 1)

    def on_tone(self, gid, ts, qq, labels, conf):
        if qq in self.bots or conf < self.P["tone_min_conf"]:
            return None
        labels = [l for l in labels if l in TONE]
        if not labels:
            return None
        g = self.advance(gid, ts); per = self._person(gid, qq)
        half = "真敌意" in labels and "调侃" in labels      # 半真半假的敌意按半扣
        c = p = irr = 0.0
        for l in labels:
            dc, dp, di = TONE[l]
            if l == "真敌意" and half: dc, dp, di = dc / 2, dp / 2, di / 2
            c += dc; p += dp; irr += di
        if c < 0: c *= self.P["neg_x"]
        self._close(gid, qq, ts, c, "tone", "语气:" + "+".join(labels))
        g["p"] = clamp(g["p"] + p, -1, 1)
        per["irr"] = self._irr(per, ts) + irr; per["irr_t"] = ts
        return c

    # ---------- 读状态 ----------
    def closeness(self, gid, qq, ts):
        per = self.people.get((gid, qq))
        if not per: return 0.0
        tau = self.P["close_tau_days"] * 86400
        return sum(v * math.exp(-(ts - t) / tau) for t, v in per["ev"] if t <= ts)

    def familiarity(self, gid, qq, ts):
        per = self.people.get((gid, qq))
        if not per: return 0
        n = len(per["days"]); idle = (ts - per["last_addr"]) / 86400
        if idle > self.P["fam_idle_days"]:
            n = max(min(n, self.P["fam_floor"]), n - int((idle - self.P["fam_idle_days"]) // 7))
        return n

    def view(self, gid, qq, ts):
        g = self.advance(gid, ts)
        per = self.people.get((gid, qq))
        irr = self._irr(per, ts) if per else 0.0
        close = self.closeness(gid, qq, ts) if qq else 0.0
        if g["p"] < -0.6: att = "愤怒"
        elif g["p"] < -0.3 or irr > 0.5: att = "不满"
        elif g["p"] > 0.4: att = "高兴"
        elif g["a"] < 0.3: att = "慵懒"
        else: att = "平静"
        score = 0.5 + 0.25 * math.tanh(close / 6) + 0.15 * g["p"] + 0.3 * (g["a"] - 0.5) - 0.5 * irr
        will = "热情" if score >= 0.75 else "正常" if score >= 0.4 else "敷衍" if score >= 0.2 else "懒得回"
        if qq == self.owner and will == "懒得回": will = "敷衍"     # 主人永远会回
        return {"p": round(g["p"], 3), "a": round(g["a"], 3), "close": round(close, 2),
                "fam": self.familiarity(gid, qq, ts) if qq else 0, "irr": round(irr, 3),
                "attitude": att, "will": will, "score": round(score, 3)}
