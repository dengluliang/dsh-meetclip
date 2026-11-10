"""纪要的提示词与解析：纯函数，不碰数据库和网络，便于单测。

骨架来自知了（Cicada）的 `Notes.swift`，做过几处适配：
- 转写行用 MeetClip 的秒数 + 发言人，锚点统一换算成**秒**（终稿会整表重插，行 id 不可依赖）；
- 提示词改为中文，并保留它验证过的硬规则（主题粒度、证据必填、术语只留"听错的"）；
- 长会议终稿切成窗口喂，每窗都带上一窗的纪要，避免一次塞几万字；
- 会议/视频/直播三套场景模板拆在 `minutes_scenarios.py`，JSON 结构保持 Cicada 原样。
"""
from __future__ import annotations

import hashlib
import json
import re
from difflib import SequenceMatcher

import minutes_scenarios as scenarios
from ai import providers

# 一次最多喂多少行：直播增量 200 行足够覆盖一个更新周期，终稿按 300 行切窗口。
LIVE_MAX_LINES = 200
FINAL_WINDOW = 300
# 少于这么多句就不必调用（刚开播时没有可总结的内容）。
MIN_LINES = 3

# 主题起点只用转写时间做锚：模型自己把 "1:09:47" 换算成秒时会算错（写成 1:49:47，
# 比整条视频还长），时间轴于是指向不存在的片段。起点不可能晚于自己的第一条证据，
# 可以早一点（章节开场白常不带结论句），但不能早太多。
TOPIC_START_LEAD = 180.0
TOPIC_START_LAG = 5.0


def clock(seconds: float) -> str:
    total = max(0, int(seconds or 0))
    if total >= 3600:
        return f"{total // 3600}:{total % 3600 // 60:02d}:{total % 60:02d}"
    return f"{total // 60:02d}:{total % 60:02d}"


def topics_cap(duration: float, scenario: str = "meeting") -> int:
    """主题/章节/看点上限：会议 3 分钟一段，视频和直播 5 分钟一段。"""
    return scenarios.topics_cap(duration, scenario)


def line_text(index: int, start: float, label: str, text: str) -> str:
    who = label or "未识别"
    return f"[L{index + 1} {clock(start)} {who}] {text}"


def _point_id(text) -> str:
    """要点短 id：只由文字决定，同一句话每次算出来都一样。"""
    return hashlib.sha1(str(text or "").strip().encode("utf-8")).hexdigest()[:6]


def _compact(notes: dict) -> str:
    """喂回模型的"当前纪要"：去掉记录用的字段（时间、证据数），只留内容。"""
    def points(topic):
        # 带一个由文本算出的短 id：分窗终稿里模型改写要点时，只要把 id 带回来，
        # 原有时间锚点就能接回去（比"文本逐字相同"稳得多）。
        return [{"text": p.get("text", ""), "id": _point_id(p.get("text"))}
                for p in topic.get("points", []) if p.get("text")]

    payload = {
        "title": notes.get("title") or "",
        "summary": notes.get("summary") or "",
        "topics": [{"start": round(float(t.get("start") or 0), 1), "title": t.get("title", ""),
                    "summary": t.get("summary", ""), "points": points(t),
                    "fishbone": t.get("fishbone") or None} for t in notes.get("topics") or []],
        "conclusions": [c.get("text", "") for c in notes.get("conclusions") or []],
        "todos": [c.get("text", "") for c in notes.get("todos") or []],
        "terms": notes.get("terms") or [],
    }
    return json.dumps(payload, ensure_ascii=False)


def _rules(language: str, final: bool, duration: float, empty_topics: bool, last_topic: dict | None,
           newest: float, scenario: str = "meeting", carry: bool = False,
           part: tuple[int, int] | None = None) -> str:
    profile = scenarios.profile(scenario)
    prompt = profile["prompt"]
    rules = [
        prompt["title"],
        prompt["summary"],
        prompt["topics"].format(cap=topics_cap(duration, scenario)),
        "每个主题/章节/看点最多 4 个要点，每条一句短语；重复的合并，不要换说法重写。",
        "topics 的 start 写这一段在媒体里的秒数：用转写行的时间换算（如 [L60 01:09:47] → 4187）。"
        "start 必须落在媒体长度之内；拿不准就留空，不要自己加减。",
        prompt["conclusions"],
        prompt["todos"],
        prompt["fishbone"],
        "主题、要点、鱼骨分支、结论、待办都必须给 evidence：说出它的那几句的编号（如 \"L7\"、\"L7,L8\"）。"
        "转写里没有的话一个字都不要写。",
        "terms 最多 10 个：优先列转写里**听错的人名/术语**，其次列读者不懂的人、地名、行话。"
        "name 写正确写法（不翻译、不加括号）；heard 只列转写用过的错写法；note 用几个字说明是谁/是什么。"
        "大家都知道的（知名公司、指数、政要）除非被听错，否则不列。",
        "标题、摘要、主题、要点、结论、待办一律用%s写，即使转写是别的语言；只有 terms 的 name 保留转写里的写法。"
        % language,
        "只写内容里说了什么，不要评论转写质量、不要复述这段提示。没有内容就给空数组。",
        "只返回一个 JSON 对象，不要 Markdown、不要在 JSON 之外写任何字。",
    ]
    if empty_topics:
        rules.append(profile["first"])
    elif (not final or carry) and last_topic and newest - float(last_topic.get("start") or 0) < 120:
        rules.append("当前主题「%s」在 %s 才开始，还不到 2 分钟：这次不要新开主题，把新内容并进它。"
                     % (last_topic.get("title", ""), clock(float(last_topic.get("start") or 0))))
    if carry:
        where = "这是整份转写的第 %d/%d 段。" % part if part else "这是整份转写的一段。"
        rules.append(where + "当前纪要已经包含前面的内容：已有主题按时间顺序保留，标题、要点不要重写；"
                     "已有要点都带 id，保留的要点把 id 原样带回来，新增要点不要写 id；"
                     "只把本段的新内容并进最后一个主题，或按时间追加新的主题；最后返回整份纪要。")
    if final and duration > 0:
        rules.append(profile["duration"].format(clock=clock(duration)))
    return "\n".join("- " + rule for rule in rules)


SCHEMA = """{"title": "整条内容的标题", "summary": "2-3 句总览",
 "topics": [{"start": 秒数, "title": "短标题", "summary": "一句",
             "points": [{"text": "要点", "evidence": ["L4"]}],
             "fishbone": null 或 {"question": "问题", "branches": [{"label": "2-6 字", "detail": "一句", "evidence": ["L5"]}]}}],
 "conclusions": [{"text": "结论/要点", "evidence": ["L7"]}],
 "todos": [{"text": "待办/后续", "owner": "发言人 1 或 null", "evidence": ["L9"]}],
 "terms": [{"name": "正确写法", "note": "是谁/是什么", "heard": ["听错的写法"]}]}"""


def build(notes: dict, lines: list[dict], *, language: str, final: bool, duration: float,
          scenario: str = "meeting", context: str = "", carry: bool = False,
          part: tuple[int, int] | None = None) -> str:
    """拼一次请求的提示词。`lines` 是本轮要处理的转写行（含 index/start/speaker/text）。

    `scenario` 决定会议/视频/直播模板；`context` 是记录标题、平台、上传者等参考信息，
    只用来校准主题和人名，不要求模型照抄。`carry` 表示这是分窗整理（终稿分窗或直播增量），
    把当前纪要一起发回去，让模型在已有主题上追加，而不是每窗各写一份。
    """
    profile = scenarios.profile(scenario)
    body = "\n".join(line_text(l["index"], l["start"], l.get("label") or "", l["text"]) for l in lines)
    context_tail = ""
    if (not final or carry) and notes.get("_context"):
        context_tail = "刚刚说过的几句（仅作上下文，不要重复整理）：\n%s\n\n" % notes["_context"]
    current = ""
    if notes.get("topics") and (not final or carry):
        current = "当前纪要（JSON）：\n%s\n\n" % _compact(notes)
    reference = ""
    if context.strip():
        reference = "参考信息（只用来校准主题和人名，不要照抄）：%s\n\n" % context.strip()[:500]
    last_topic = (notes.get("topics") or [None])[-1]
    newest = max((l["start"] for l in lines), default=0.0)
    head = profile["prompt"]["head_final" if final else "head_live"]
    return (
        f"{head}\n只返回 JSON。\n\n"
        f"{reference}{current}{context_tail}"
        "转写（编号、时间、说话人、内容；说话人是按声音分的，可能不准；未识别=对方某人）：\n"
        f"{body}\n\n"
        "返回的 JSON 结构：\n" + SCHEMA + "\n\n规则：\n" + _rules(language, final, duration, not notes.get("topics"),
                                                              last_topic, newest, scenario, carry, part)
    ) + ("\n\n再次确认：用%s写，只返回 JSON 对象。返回的 JSON 结构见上。" % language)


def _num(value) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def _evidence_ids(value) -> set[int]:
    if isinstance(value, str):
        value = [value]
    ids = set()
    for item in value or []:
        if not isinstance(item, str):
            continue
        digits = re.sub(r"[^0-9]", "", item)
        if digits:
            ids.add(int(digits))
    return ids


def _str(value) -> str:
    return value.strip() if isinstance(value, str) else ""


def evidence_times(topic: dict) -> list[float]:
    """一个主题里能对上转写的时间点：优先要点的 t，没有要点才用鱼骨分支的 t。

    不用全部取最小值：鱼骨分支常在上文更早处提过一次（例如"缓存缩水"在开场就说过），
    拿它当章节起点会把章节整体拽到前文去。要点才是这一段实际讲的内容。
    """
    points = []
    branches = []
    for point in topic.get("points") or []:
        if isinstance(point, dict) and point.get("t") is not None:
            points.append(point["t"])
    fishbone = topic.get("fishbone")
    if isinstance(fishbone, dict):
        for branch in fishbone.get("branches") or []:
            if isinstance(branch, dict) and branch.get("t") is not None:
                branches.append(branch["t"])
    values = points or branches
    out = []
    for value in values:
        try:
            out.append(float(value))
        except (TypeError, ValueError):
            continue
    return out


def topic_start(value, anchors: list[float], media_end: float | None = None,
                fallback: float = 0.0) -> float:
    """主题起点：模型给的秒数只在能对上证据时采用，否则回落到最早一条证据。

    - 起点不可能晚于自己的第一条证据（最多 TOPIC_START_LAG 的取整误差）；
    - 可以比第一条证据早一点（章节开场白常不带结论句），早过 TOPIC_START_LEAD 就不认，
      但只有一条证据时不硬拽——孤立的一条引用可能来自别的段落；
    - 超出媒体长度的值一律不认——这正是时间轴指向 1:49:47 却只有 1:19:20 的根因。
    """
    start = float(value) if value is not None else None
    if start is not None and start < 0:
        start = None
    earliest = min(anchors) if anchors else None
    if earliest is not None:
        if start is None or start > earliest + TOPIC_START_LAG:
            return float(earliest)
        if start < earliest - TOPIC_START_LEAD and len(anchors) >= 2:
            return float(earliest)
        return float(start)
    if start is not None and start > 0 and (media_end is None or media_end <= 0 or start <= media_end):
        return float(start)
    return float(fallback or 0.0)


def sanitize_topics(topics, media_end: float = 0.0) -> bool:
    """就地修正旧纪要的主题起点，返回是否改动。

    只读兜底：已经存进库里的纪要可能是旧版本写坏的（起点落在媒体之外，或比自己的
    第一条证据晚了半个多小时），页面、笔记、导出、Agent 读到的都应该先经过这里。
    """
    changed = False
    previous = 0.0
    for topic in topics or []:
        if not isinstance(topic, dict):
            continue
        start = _num(topic.get("start"))
        fixed = topic_start(start, evidence_times(topic), media_end, fallback=previous)
        if media_end and media_end > 0:
            fixed = min(fixed, float(media_end))
        # 时间轴必须单调：修出来的起点不能跑到上一个主题前面。
        fixed = max(fixed, previous)
        if start is None or abs(float(start) - fixed) > 0.5:
            topic["start"] = fixed
            changed = True
        previous = fixed
    return changed


def parse(raw: str, times: list[float]) -> dict | None:
    """把模型回复解析成纪要。宽容但严格：缺字段当空，证据编号超出范围就丢掉。"""
    text = raw.strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        root = json.loads(text[start:end + 1])
    except ValueError:
        return None
    if not isinstance(root, dict):
        return None

    def evidence(value) -> list[int]:
        return sorted(i for i in _evidence_ids(value) if 1 <= i <= len(times))

    def anchor(value) -> tuple[float | None, int]:
        ids = evidence(value)
        return ((times[ids[0] - 1] if ids else None), len(ids))

    notes: dict = {"summary": _str(root.get("summary")), "topics": [], "conclusions": [],
                   "todos": [], "terms": []}
    title = _str(root.get("title")).strip("\"'“”「」《》")
    if title:
        notes["title"] = title
    media_end = max(times) if times else 0.0
    previous_start = min(times) if times else 0.0

    for topic in root.get("topics") or []:
        if not isinstance(topic, dict):
            continue
        name = _str(topic.get("title"))
        if not name:
            continue
        points = []
        for point in topic.get("points") or []:
            if isinstance(point, dict):
                ptext, anchor_value = _str(point.get("text")), point.get("evidence")
            else:
                ptext, anchor_value = _str(point), None
            if not ptext:
                continue
            when, support = anchor(anchor_value)
            ident = _str(point.get("id")) if isinstance(point, dict) else ""
            points.append({"text": ptext, "t": when, "support": support, "id": ident})
        fishbone = None
        raw_fish = topic.get("fishbone")
        if isinstance(raw_fish, dict):
            branches = []
            for branch in raw_fish.get("branches") or []:
                if not isinstance(branch, dict):
                    continue
                label = _str(branch.get("label"))
                if not label:
                    continue
                when, support = anchor(branch.get("evidence"))
                branches.append({"label": label, "detail": _str(branch.get("detail")),
                                 "t": when, "support": support})
            if len(branches) >= 2:
                fishbone = {"question": _str(raw_fish.get("question")), "branches": branches}
        when, support = anchor(topic.get("evidence"))
        anchors = evidence_times({"points": points, "fishbone": fishbone})
        if not anchors and when is not None:
            anchors = [when]
        start = topic_start(_num(topic.get("start")), anchors, media_end, fallback=previous_start)
        previous_start = start
        notes["topics"].append({
            "start": start,
            "title": name, "summary": _str(topic.get("summary")), "points": points,
            "fishbone": fishbone, "support": max(support, len([p for p in points if p["support"]])),
        })

    for key in ("conclusions", "todos"):
        for item in root.get(key) or []:
            if not isinstance(item, dict):
                continue
            body = _str(item.get("text"))
            if not body:
                continue
            when, support = anchor(item.get("evidence"))
            entry = {"text": body, "t": when, "support": support}
            owner = _str(item.get("owner"))
            if owner and key == "todos":
                entry["owner"] = owner
            notes[key].append(entry)

    for term in root.get("terms") or []:
        if not isinstance(term, dict):
            continue
        name = _str(term.get("name"))
        if not name:
            continue
        heard = [h for h in (_str(h) for h in term.get("heard") or []) if h and h != name]
        notes["terms"].append({"name": name, "note": _str(term.get("note")), "heard": heard})

    if notes["terms"]:
        # 模型只会越攒越多：留 20 个以内，听错的排在前面（读者自己猜不出来）。
        notes["terms"].sort(key=lambda t: (0 if t["heard"] else 1, t["name"]))
        notes["terms"] = notes["terms"][:20]
    if not notes["summary"] and not notes["topics"]:
        return None
    return notes


def _similar(a, b) -> float:
    """两段文字的相似度（0–1）：模型改写要点后仍能认出是同一条。"""
    left, right = str(a or "").strip(), str(b or "").strip()
    if not left or not right:
        return 0.0
    if left == right:
        return 1.0
    return SequenceMatcher(None, left, right).ratio()


def _old_topic_for(topic: dict, old_topics: list[dict], used: set[int]) -> int | None:
    """给新主题找上一版里对应的主题：标题一致优先，其次起点相近（±90 秒）。"""
    title = _topic_key(topic.get("title"))
    start = _num(topic.get("start"))
    best = None
    best_score = 0
    for index, candidate in enumerate(old_topics):
        if index in used:
            continue
        score = 0
        if title and _topic_key(candidate.get("title")) == title:
            score = 2
        elif start is not None:
            old_start = _num(candidate.get("start"))
            if old_start is not None and abs(old_start - start) <= 90:
                score = 1
        if score > best_score:
            best, best_score = index, score
    return best


def carry_times(old: dict, new: dict) -> dict:
    """模型重复输出老要点时往往不带证据：沿用老时间；有证据则取更早的那个（说第一次的时候）。

    主题起点同理：模型每次重写都可能把老主题的 start 算后（甚至算到媒体长度之外），
    同名主题只前移、不后移。

    分窗终稿时模型常常把老主题的要点改写一遍（文本不再逐字相同），所以除了按原文匹配，
    还给"起点相近的主题"按位置对一遍；两段文字足够像才算同一个要点，避免把时间挂错。
    """
    old_topics = [topic for topic in old.get("topics") or [] if isinstance(topic, dict)]
    known: dict[str, tuple] = {}
    known_ids: dict[str, tuple] = {}
    old_starts: dict[str, float] = {}
    for topic in old_topics:
        name = str(topic.get("title") or "").strip()
        start = topic.get("start")
        if name and start is not None:
            try:
                old_starts[name] = float(start)
            except (TypeError, ValueError):
                pass
        for point in topic.get("points") or []:
            if point.get("t") is not None or point.get("support"):
                carried = (point.get("t"), int(point.get("support") or 0))
                known[str(point.get("text") or "")] = carried
                if point.get("text"):
                    known_ids[_point_id(point.get("text"))] = carried
    used: set[int] = set()
    for topic in new.get("topics") or []:
        match = _old_topic_for(topic, old_topics, used)
        if match is not None:
            used.add(match)
        prior = old_starts.get(str(topic.get("title") or "").strip())
        if prior is not None:
            start = topic.get("start")
            topic["start"] = prior if start is None else min(float(start), prior)
        old_points = (old_topics[match].get("points") or []) if match is not None else []
        for index, point in enumerate(topic.get("points") or []):
            carried = known_ids.get(str(point.get("id") or ""))
            if carried is None:
                carried = known.get(str(point.get("text") or ""))
            if carried is None and index < len(old_points):
                prior_point = old_points[index]
                if _similar(point.get("text"), prior_point.get("text")) >= 0.35:
                    carried = (prior_point.get("t"), int(prior_point.get("support") or 0))
            if carried is None:
                continue
            old_time, old_support = carried
            if old_time is not None:
                point["t"] = old_time if point.get("t") is None else min(point["t"], old_time)
            if old_support:
                point["support"] = max(int(point.get("support") or 0), old_support)
        topic["support"] = max(int(topic.get("support") or 0),
                               sum(1 for point in topic.get("points") or [] if point.get("support")))
    for key in ("conclusions", "todos"):
        old_items = [item for item in old.get(key) or [] if isinstance(item, dict)]
        for item in new.get(key) or []:
            carried = None
            for candidate in old_items:
                if str(candidate.get("text") or "") == str(item.get("text") or ""):
                    carried = (candidate.get("t"), int(candidate.get("support") or 0))
                    break
            if carried is None:
                for candidate in old_items:
                    if _similar(candidate.get("text"), item.get("text")) >= 0.55:
                        carried = (candidate.get("t"), int(candidate.get("support") or 0))
                        break
            if carried is None:
                continue
            old_time, old_support = carried
            if old_time is not None:
                item["t"] = old_time if item.get("t") is None else min(item["t"], old_time)
            if old_support:
                item["support"] = max(int(item.get("support") or 0), old_support)
    return new


def _topic_key(title) -> str:
    """标题比对用：去掉空白和标点，"预算·评审" 与 "预算评审" 视为同一个主题。"""
    return re.sub(r"[\s·、，,。.：:；;（）()\[\]【】\-—_/]+", "", str(title or ""))


def strip_point_ids(notes: dict) -> None:
    """落库前去掉临时 id：它只用来跨窗接时间，不该出现在纪要/导出里。"""
    for topic in notes.get("topics") or []:
        for point in topic.get("points") or []:
            if isinstance(point, dict):
                point.pop("id", None)


def merge_window(old: dict, new: dict) -> dict:
    """分窗终稿：旧主题原样保留，只把这一窗新整理出来的主题追加进来。

    分窗时会把当前纪要整份发回给模型，但模型经常借机把前面几窗的主题重写一遍——重写后的
    要点没有证据行号，时间锚点就丢了（实测 79 分钟的片子 72 条要点只剩 18 条带时间）。
    所以这里以旧主题为准：标题/起点对得上的（模型重写的那一份）直接丢弃，对不上的才当成
    本窗的新主题追加。总结、要点、待办、术语仍用模型的最新版本（它们本来就是全局的）。
    """
    merged = carry_times(old, new)
    # 全局段落（总结/要点/待办/术语）不该因为某一窗没重复就整段消失。
    for key in ("summary", "conclusions", "todos", "terms"):
        if not merged.get(key) and old.get(key):
            merged[key] = old[key]
    base_topics = [topic for topic in old.get("topics") or [] if isinstance(topic, dict)]
    known = {_topic_key(topic.get("title")) for topic in base_topics}
    known_starts = [_num(topic.get("start")) for topic in base_topics]
    added = []
    for topic in merged.get("topics") or []:
        if not isinstance(topic, dict):
            continue
        if _topic_key(topic.get("title")) in known:
            continue
        start = _num(topic.get("start"))
        if start is not None and any(item is not None and abs(item - start) <= 90 for item in known_starts):
            continue
        added.append(topic)
    topics = list(base_topics)
    for topic in added:
        start = _num(topic.get("start")) or 0.0
        index = next((i for i, item in enumerate(topics)
                      if (_num(item.get("start")) or 0.0) > start), len(topics))
        topics.insert(index, topic)
    merged["topics"] = topics
    return merged


def written_in(notes: dict, language: str) -> bool:
    """纪要自己的话（摘要、主题标题）是否真的用目标语言写的——中文/日文/韩文需要相当比例的 CJK。"""
    text = (notes.get("summary") or "") + "".join(t.get("title", "") for t in notes.get("topics") or [])
    letters = [ch for ch in text if ch.isalpha()]
    if not letters:
        return True
    cjk = sum(1 for ch in letters if _is_cjk(ch))
    if providers.wants_cjk(language):
        return cjk * 5 >= len(letters)
    return cjk * 2 < len(letters)


def _is_cjk(ch: str) -> bool:
    code = ord(ch)
    return 0x3040 <= code <= 0x9FFF or 0xAC00 <= code <= 0xD7AF


def plan_final(total: int, window: int = FINAL_WINDOW) -> list[tuple[int, int]]:
    """终稿分窗：[(from, upto)]，最后一段允许整体重写主题。"""
    if total <= 0:
        return []
    spans = [(start, min(start + window, total)) for start in range(0, total, window)]
    return spans


def context_tail(lines: list[dict], count: int = 2) -> str:
    return "\n".join(line_text(l["index"], l["start"], l.get("label") or "", l["text"])
                     for l in lines[-count:])
