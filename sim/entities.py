"""전투 참가자(struct) 생성.

참가자는 순수 dict 이다(GML struct 로 그대로 옮기기 쉽게, 직렬화 가능한 값만 쓴다).
"""

STAT_DEFAULTS = {
    "spirit": 0, "body": 0, "mind": 0, "psychic": 0,
    "strength": 0, "phys_res": 0, "regen": 0, "smell": 0,
    "accuracy": 0, "flexibility": 0, "agility": 0, "poison_res": 0,
    "stealth": 0,       # 인식방해
    "obsession": 0,     # 집착
    "endurance": 0,     # 인내심 (행동불가 저항)
    "dexterity": 0,     # 손재주 (판정 가산, 아직 효과 없음)
    "spirit_regen": 0,  # 영혼 재생력
}


def eff_stat(c, stat):
    """기본값 + 장비(내구도가 남은 것만) + 손상 부위 + 사냥 숙련(상대 한정)."""
    v = c["base_stats"].get(stat, 0)
    for item in c["gear"]:
        if item["durability"] is None or item["durability"] > 0:
            v += item["bonuses"].get(stat, 0)
    v += c["part_penalty"].get(stat, 0)
    v += c["vs_bonus"].get(stat, 0)
    return v


def _new_combatant(db, cid, name, side, base_stats, skills, gear, ranged, grade, humanoid, is_player):
    stats = dict(STAT_DEFAULTS)
    stats.update(base_stats)
    rules = db["rules"]
    c = {
        "id": cid,
        "name": name,
        "side": side,
        "is_player": is_player,
        "base_stats": stats,
        "gear": gear,
        "skills": list(skills),
        "ranged": ranged,
        "grade": grade,
        "humanoid": humanoid,
        "hp": float(rules["max_hp"]),
        "max_hp": float(rules["max_hp"]),
        "spirit": 0.0,
        "max_spirit": 0.0,
        "cooldowns": {},
        "status": {},
        "stunned": False,
        "shield": 0.0,
        "damaged_parts": [],
        "part_penalty": {},
        "vs_bonus": {},
        "action_gauge": 0.0,
        "alive": True,
        "incapacitated": False,
    }
    c["max_spirit"] = float(eff_stat(c, "spirit") * rules["spirit_scale"])
    c["spirit"] = c["max_spirit"]
    return c


def make_gear(db, item_id):
    group = "weapons" if item_id in db["equipment"]["weapons"] else "armor"
    item = db["equipment"][group][item_id]
    return {
        "id": item_id,
        "slot": item["slot"],
        "bonuses": dict(item["bonuses"]),
        "durability": item.get("durability"),
    }


def make_player(db, race="barbarian", weapon="greatsword", armor=None, skills=None, name=None, vs_mastery=0):
    """플레이어(또는 동료) 생성.

    armor 를 생략하면 바바리안 성인식 기본 방어구를 지급한다(종족 비교용으로 다른 종족에게도 같은 키트).
    vs_mastery: 상대 몬스터에 대한 사냥 숙련 단계(0~max_level).
    """
    race_def = db["races"][race]
    armor_ids = db["equipment"]["barbarian_starter_armor"] if armor is None else armor
    gear = [make_gear(db, weapon)] if weapon else []
    gear += [make_gear(db, a) for a in armor_ids]
    c = _new_combatant(
        db, race, name or race_def["name_ko"], "ally", race_def["stats"],
        skills if skills is not None else list(db["skills"].keys()),
        gear, ranged=(weapon == "bow"), grade=None, humanoid=True, is_player=True,
    )
    apply_mastery(db, c, vs_mastery)
    return c


def apply_mastery(db, c, level):
    m = db["rules"]["mastery"]
    level = max(0, min(level, m["max_level"]))
    c["vs_bonus"] = {k: v * level for k, v in m["bonus_per_level"].items()} if level else {}


def monster_stats_from_grade(db, grade):
    g = db["rules"]["monster_grade"]
    steps = g["base_grade"] - grade
    stats = {
        "strength": steps * g["strength_per_step"],
        "phys_res": steps * g["phys_res_per_step"],
    }
    if grade <= g["regen_from_grade"]:
        stats["regen"] = (g["regen_from_grade"] + 1 - grade) * g["regen_per_step"]
    return stats


def make_monster(db, monster_id):
    m = db["monsters"][monster_id]
    stats = dict(db["monster_defaults"]["stats"])
    stats.update(monster_stats_from_grade(db, m["grade"]))
    stats.update(m.get("stat_override", {}))
    return _new_combatant(
        db, monster_id, m["name_ko"], "enemy", stats,
        m.get("skills", db["monster_defaults"]["skills"]),
        [], ranged=m["ranged"], grade=m["grade"], humanoid=False, is_player=False,
    )


def make_npc(db, npc_id):
    n = db["npcs"][npc_id]
    return _new_combatant(
        db, npc_id, n["name_ko"], "enemy", n["stats"], n["skills"],
        [], ranged=n["ranged"], grade=None, humanoid=n["humanoid"], is_player=False,
    )


def make_enemy(db, enemy_id):
    if enemy_id in db["monsters"]:
        return make_monster(db, enemy_id)
    return make_npc(db, enemy_id)
