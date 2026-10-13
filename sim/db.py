"""db.json 로딩과 검증.

GameMaker 쪽의 `dungeon_stone.db -> db.json` 과 같은 파일을 읽는다.
전투 코드에는 숫자를 하드코딩하지 않고 전부 여기서 읽은 값을 쓴다.
"""
import json
import os

DEFAULT_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "db.json")

VALID_AI = ("highest_value", "attack_only", "random", "guard_when_hurt")
RACE_REQUIRED_STATS = ("spirit", "body", "mind", "psychic", "strength", "phys_res", "regen", "smell")


class DbError(ValueError):
    pass


def load_db(path=None):
    with open(path or DEFAULT_PATH, encoding="utf-8") as f:
        db = json.load(f)
    validate_db(db)
    return db


def validate_db(db):
    for key in ("rules", "skills", "races", "equipment", "monsters", "monster_defaults", "npcs"):
        if key not in db:
            raise DbError("missing top-level key: %s" % key)

    skills = db["skills"]
    for sid, s in skills.items():
        if s["kind"] not in ("attack", "defend"):
            raise DbError("skill %s: unknown kind %r" % (sid, s["kind"]))
        for field in ("cost", "cooldown"):
            if field not in s or s[field] < 0:
                raise DbError("skill %s: bad %s" % (sid, field))
        if s["kind"] == "attack" and s.get("power", 0) <= 0:
            raise DbError("skill %s: attack needs power > 0" % sid)
        for eff in s.get("on_hit", []):
            if eff["status"] not in db["rules"]["status"]:
                raise DbError("skill %s: unknown status %r" % (sid, eff["status"]))
            if not 0.0 < eff.get("chance", 1.0) <= 1.0:
                raise DbError("skill %s: on_hit chance must be in (0, 1]" % sid)

    for sid in db["player_default_skills"]:
        if sid not in skills:
            raise DbError("player_default_skills: unknown skill %s" % sid)

    for rid, r in db["races"].items():
        for st in RACE_REQUIRED_STATS:
            if st not in r["stats"]:
                raise DbError("race %s: missing stat %s" % (rid, st))

    gear = db["equipment"]
    for group in ("weapons", "armor"):
        for iid, item in gear[group].items():
            if "slot" not in item or "bonuses" not in item:
                raise DbError("equipment %s: needs slot and bonuses" % iid)
    for iid in gear["barbarian_starter_armor"]:
        if iid not in gear["armor"]:
            raise DbError("starter armor %s not defined" % iid)

    for mid, m in db["monsters"].items():
        if not 1 <= m["grade"] <= 9:
            raise DbError("monster %s: grade must be 1..9" % mid)
    if db["monster_defaults"]["ai"] not in VALID_AI:
        raise DbError("monster_defaults: unknown ai %r" % db["monster_defaults"]["ai"])
    for sid in db["monster_defaults"]["skills"]:
        if sid not in skills:
            raise DbError("monster_defaults: unknown skill %s" % sid)
    for mid, m in db["monsters"].items():
        for sid in m.get("skills", []):
            if sid not in skills:
                raise DbError("monster %s: unknown skill %s" % (mid, sid))
        if m.get("ai", "attack_only") not in VALID_AI:
            raise DbError("monster %s: unknown ai %r" % (mid, m["ai"]))
    for nid, n in db["npcs"].items():
        for sid in n["skills"]:
            if sid not in skills:
                raise DbError("npc %s: unknown skill %s" % (nid, sid))

    parts = db["rules"]["part_damage"]
    for p in parts["parts"]:
        if p not in parts["effects"]:
            raise DbError("part_damage: no effect for part %s" % p)
