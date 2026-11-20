"""T13a reading of A-02 §8.4 (number guard), §8.5 (booking claim), §8.6 (tag guard),
§11.1 (escapeUserText) and §10 (lang detection). Used only to derive expected values
for eval/cases/deterministic/*.yaml. Ambiguous points are flagged in README §6.
"""
import re
import unicodedata
from decimal import Decimal, ROUND_HALF_UP

ZW = re.compile("[​-‏⁠﻿]")

ID_RES = [
    re.compile(r"\b[qt]_[0-9A-HJKMNP-TV-Z]{26}\b"),
    re.compile(r"\bOA-[0-9A-Z]{8}\b"),
    re.compile(r"\b(run|call)_[A-Za-z0-9_]+\b"),
]
DATE_RES = [
    re.compile(r"\b\d{4}-\d{2}-\d{2}\b"),
    re.compile(r"\d{4}\s*年(\s*\d{1,2}\s*月(\s*\d{1,2}\s*日)?)?"),
    re.compile(r"\d{1,2}\s*月\s*\d{1,2}\s*日"),
]
# A-02 §8.4 shows two "space-like" chars in the class; T13a reads them as U+0020 and U+00A0 (+U+202F).
NUM_RE = re.compile(r"(\d{1,3}(?:[,   ]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(万|k|K)?")
PRICE_WORDS = ["US$", "$", "USD", "美元", "美金", "刀", "dollar", "price", "价格", "票价", "费用", "fare", "cost"]
DIST_WORDS = ["km", "公里", "千米", "kilometer", "距离", "里程", "distance"]
# a 万/亿 directly after Arabic digits belongs to the Arabic number (handled by NUM_RE), not a Chinese numeral
CN_NUM = re.compile(r"(?<![\d.])[零〇一二两三四五六七八九十百千万亿]+")


def pre(t: str) -> str:
    t = unicodedata.normalize("NFKC", t)
    t = ZW.sub("", t)
    for r in ID_RES + DATE_RES:
        t = r.sub(" ", t)
    return t


def has_word(window: str, words) -> bool:
    lw = window.lower()
    return any(wd.lower() in lw for wd in words)


def norm_num(digits: str, mult: str | None) -> str:
    v = Decimal(re.sub(r"[,   ]", "", digits))
    if mult == "万":
        v *= 10000
    elif mult in ("k", "K"):
        v *= 1000
    return str(v.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def number_guard(text: str, a_price, a_dist, a_sys_extra=()):
    a_price = {norm_num(x, None) for x in a_price}
    a_dist = {norm_num(x, None) for x in a_dist}
    a_sys = a_price | a_dist | {norm_num(x, None) for x in a_sys_extra}
    t = pre(text)
    offending = []
    for m in NUM_RE.finditer(t):
        val = norm_num(m.group(1), m.group(2))
        s, e = m.start(), m.end()
        before, after = t[max(0, s - 16):s], t[e:e + 16]
        ctx = before + " " + after
        is_price = has_word(ctx, PRICE_WORDS)
        is_dist = has_word(ctx, DIST_WORDS)
        has_dec = "." in m.group(1)
        big = Decimal(val) >= 100
        bad = False
        if is_price and val not in a_price:
            bad = True
        if is_dist and val not in a_dist:
            bad = True
        if not (is_price or is_dist) and (has_dec or big) and val not in a_sys:
            bad = True
        if bad:
            offending.append(val)
    for m in CN_NUM.finditer(t):
        s, e = m.start(), m.end()
        near = t[max(0, s - 4):s] + " " + t[e:e + 4]
        if has_word(near, PRICE_WORDS + DIST_WORDS):
            offending.append(m.group(0))
    return offending


BOOKING_CLAIM = re.compile(
    r"已(为您|帮您|给您)?(预订|订好|订票成功|出票|完成预订|搞定)|座位已(经)?(为您)?(留好|锁定)"
    r"|booked (it|your|the)|booking (is |has been )?confirmed|ticket (has been |is )?issued|you'?re all set",
    re.I,
)


def booking_claim(text: str, has_confirmed: bool) -> bool:
    t = ZW.sub("", unicodedata.normalize("NFKC", text))
    return bool(BOOKING_CLAIM.search(t)) and not has_confirmed


TAG = re.compile(r"<\s*/?\s*(system_event|run_context)\b", re.I)


def tag_guard(text: str) -> bool:
    t = ZW.sub("", unicodedata.normalize("NFKC", text))
    return bool(TAG.search(t))


def escape_user_text(text: str) -> str:
    t = ZW.sub("", unicodedata.normalize("NFKC", text))
    return TAG.sub(lambda m: "&lt;" + m.group(0)[1:], t)


CJK = re.compile(r"[㐀-䶿一-鿿豈-﫿]")
LATIN = re.compile(r"[A-Za-z]")


def detect_lang(text: str):
    chars = [c for c in text if not c.isspace()]
    if not chars:
        return None
    cjk = sum(1 for c in chars if CJK.match(c))
    ratio = cjk / len(chars)
    if ratio >= 0.3:
        return "zh", ratio
    if LATIN.search(text) and ratio < 0.1:
        return "en", ratio
    return None, ratio
