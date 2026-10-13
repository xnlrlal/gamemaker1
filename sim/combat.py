"""전투 코어 (기획서 4장).

한 라운드 = 아군(플레이어 → 동료) → 적 → 라운드 종료 처리.
공격 판정 흐름(4-3): 명중 → 치명타 → 즉사 → 피해 계산 → 방어막 흡수 → 부가효과(상태이상·부위 손상).
모든 수치는 db["rules"] / db["skills"] 에서 읽는다.
"""
import math
import random

from .entities import eff_stat


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


# ---------------------------------------------------------------- 상태 생성

def new_combat(db, allies, enemy, seed=0, policies=None):
    """전투 상태 생성. allies[0] 이 직접 조작하는 플레이어."""
    return {
        "db": db,
        "round": 0,
        "allies": allies,
        "enemy": enemy,
        "rng": random.Random(seed),
        "log": [],
        "result": None,        # None / "victory" / "defeat" / "timeout"
        "instakill": False,
        "policies": policies or {},   # actor id -> policy 이름. 없으면 기본 정책
    }


def _log(state, msg):
    state["log"].append("R%d %s" % (state["round"], msg))


# ---------------------------------------------------------------- 스킬 사용 가능 여부 / 정책

def skill_usable(state, actor, skill_id):
    s = state["db"]["skills"][skill_id]
    return actor["cooldowns"].get(skill_id, 0) <= 0 and actor["spirit"] >= s["cost"]


def usable_skills(state, actor):
    return [sid for sid in actor["skills"] if skill_usable(state, actor, sid)]


def skill_value(state, actor, skill_id):
    """정책이 스킬을 비교할 때 쓰는 값. 공격은 위력(근력 반영), 방어는 방어막 두께."""
    rules = state["db"]["rules"]
    s = state["db"]["skills"][skill_id]
    if s["kind"] == "attack":
        return s["power"] * (1 + eff_stat(actor, "strength") * rules["damage"]["per_strength"])
    return s["shield_base"] + eff_stat(actor, "phys_res") * s["shield_per_phys_res"]


def policy_highest_value(state, actor):
    """기획서 4-10 자동 플레이 정책: 쓸 수 있는 스킬 중 값이 가장 높은 것 우선."""
    best, best_v = None, -1.0
    for sid in usable_skills(state, actor):
        v = skill_value(state, actor, sid)
        if v > best_v:
            best, best_v = sid, v
    return best


def policy_attack_only(state, actor):
    best, best_v = None, -1.0
    for sid in usable_skills(state, actor):
        if state["db"]["skills"][sid]["kind"] != "attack":
            continue
        v = skill_value(state, actor, sid)
        if v > best_v:
            best, best_v = sid, v
    return best


def policy_random(state, actor):
    options = usable_skills(state, actor)
    return state["rng"].choice(options) if options else None


def policy_guard_when_hurt(state, actor):
    """평소엔 가장 센 공격, 생명력이 임계값 아래로 떨어지면 방어 스킬을 우선(방패병류)."""
    threshold = state["db"]["rules"]["ai"]["guard_hp_threshold"]
    if actor["hp"] < actor["max_hp"] * threshold:
        for sid in usable_skills(state, actor):
            if state["db"]["skills"][sid]["kind"] == "defend":
                return sid
    return policy_attack_only(state, actor)


POLICIES = {
    "highest_value": policy_highest_value,
    "attack_only": policy_attack_only,
    "random": policy_random,
    "guard_when_hurt": policy_guard_when_hurt,
}
DEFAULT_POLICY = "highest_value"


def choose_skill(state, actor):
    """정책 우선순위: 전투 시작 때 지정한 정책 > 참가자 자신의 ai(몬스터 DB) > 기본 정책."""
    name = state["policies"].get(actor["id"]) or actor.get("ai") or DEFAULT_POLICY
    return POLICIES[name](state, actor)


# ---------------------------------------------------------------- 피해 / 상태이상

def _kill(state, c):
    c["hp"] = 0.0
    if c["humanoid"] and not c["is_player"]:
        c["incapacitated"] = True   # 인간형 NPC 는 죽지 않고 전투불능
    c["alive"] = False
    _log(state, "%s %s" % (c["name"], "전투불능" if c["incapacitated"] else "쓰러짐"))


def _lose_hp(state, c, amount):
    c["hp"] -= amount
    if c["hp"] <= 0 and c["alive"]:
        _kill(state, c)


def _absorb_with_shield(c, dmg):
    if c["shield"] <= 0:
        return dmg
    absorbed = min(c["shield"], dmg)
    c["shield"] -= absorbed
    return dmg - absorbed


def apply_status(state, target, status_id, stacks, duration):
    rules = state["db"]["rules"]["status"]
    if status_id == "stun":
        res = _clamp(eff_stat(target, rules["stun"]["resist_stat"]) * rules["stun"]["resist_per_point"],
                     0, rules["stun"]["max_resist"])
        if state["rng"].random() < res:
            _log(state, "%s 기절 저항" % target["name"])
            return
        target["stunned"] = True
        _log(state, "%s 기절" % target["name"])
        return
    cfg = rules[status_id]
    cur = target["status"].get(status_id)
    if cur is None:
        target["status"][status_id] = {"stacks": min(stacks, cfg["stack_cap"]), "duration": duration}
    else:
        cur["stacks"] = min(cur["stacks"] + stacks, cfg["stack_cap"])
        cur["duration"] = max(cur["duration"], duration)   # 합산이 아니라 긴 쪽
    _log(state, "%s %s x%d" % (target["name"], status_id, target["status"][status_id]["stacks"]))


def _damage_part(state, defender):
    pd = state["db"]["rules"]["part_damage"]
    if state["rng"].random() >= pd["chance"]:
        return
    free = [p for p in pd["parts"] if p not in defender["damaged_parts"]]
    if not free:
        return
    part = state["rng"].choice(free)
    defender["damaged_parts"].append(part)
    eff = pd["effects"][part]
    defender["part_penalty"][eff["stat"]] = defender["part_penalty"].get(eff["stat"], 0) + eff["delta"]
    slot = pd["gear_slot"].get(part)
    if slot:
        for item in defender["gear"]:
            if item["slot"] == slot and item["durability"] is not None and item["durability"] > 0:
                item["durability"] = max(0, item["durability"] - pd["durability_loss"])
                if item["durability"] == 0:
                    _log(state, "%s 파손(사라짐)" % item["id"])
    _log(state, "%s 부위 손상: %s" % (defender["name"], part))


# ---------------------------------------------------------------- 공격 판정

def hit_chance(rules, attacker, defender):
    h = rules["hit"]
    p = (h["base"]
         + eff_stat(attacker, "accuracy") * h["per_accuracy"]
         - eff_stat(defender, "flexibility") * h["per_flexibility"]
         - eff_stat(defender, "stealth") * h["per_stealth"])
    return _clamp(p, h["min"], h["max"])


def crit_chance(rules, attacker):
    c = rules["crit"]
    return min(c["max"], c["base"] + eff_stat(attacker, "flexibility") * c["per_flexibility"])


def crit_multiplier(rules, attacker):
    c = rules["crit"]
    return min(c["mult_max"], c["mult_base"] + eff_stat(attacker, "obsession") * c["mult_per_obsession"])


def instakill_chance(rules, attacker):
    """몬스터 등급이 높을수록(강할수록) 조금씩 증가, 원거리는 추가. 가장 약한 근접 몬스터는 0."""
    ik = rules["instakill"]
    if attacker["grade"] is None:
        return 0.0
    p = (ik["base_grade"] - attacker["grade"]) * ik["per_grade_step"]
    if attacker["ranged"]:
        p += ik["ranged_bonus"]
    return min(ik["cap"], max(0.0, p))


def mitigation(rules, defender):
    m = rules["mitigation"]
    return _clamp(eff_stat(defender, "phys_res") * m["per_phys_res"], 0.0, m["cap"])


def resolve_attack(state, attacker, defender, skill_id):
    db = state["db"]
    rules = db["rules"]
    skill = db["skills"][skill_id]
    rng = state["rng"]

    if rng.random() >= hit_chance(rules, attacker, defender):
        _log(state, "%s %s -> %s 회피" % (attacker["name"], skill["name_ko"], defender["name"]))
        return

    crit = rng.random() < crit_chance(rules, attacker)

    if defender["is_player"] and attacker["grade"] is not None:
        p = instakill_chance(rules, attacker)
        if p > 0 and rng.random() < p:
            state["instakill"] = True
            _log(state, "%s 헤드샷 즉사!" % attacker["name"])
            _kill(state, defender)
            return

    dmg = skill["power"] * (1 + eff_stat(attacker, "strength") * rules["damage"]["per_strength"])
    if crit:
        dmg *= crit_multiplier(rules, attacker)
    dmg = max(rules["damage"]["min_damage"], dmg * (1 - mitigation(rules, defender)))
    dmg = _absorb_with_shield(defender, dmg)
    _log(state, "%s %s -> %s %s%.1f" % (attacker["name"], skill["name_ko"], defender["name"],
                                       "치명타 " if crit else "", dmg))
    if dmg > 0:
        _lose_hp(state, defender, dmg)

    if not defender["alive"]:
        return
    for eff in skill.get("on_hit", []):
        if rng.random() >= eff.get("chance", 1.0):
            continue
        apply_status(state, defender, eff["status"], eff.get("stacks", 1), eff.get("duration", 1))
    _damage_part(state, defender)


def do_action(state, actor, skill_id):
    skill = state["db"]["skills"][skill_id]
    actor["spirit"] -= skill["cost"]
    # 쿨타임 N(>=1) = 사용 후 N라운드 동안 사용 불가(라운드 종료 때 1 깎이므로 +1). 0 이면 제한 없음(한 라운드에 여러 번 가능).
    actor["cooldowns"][skill_id] = skill["cooldown"] + 1 if skill["cooldown"] > 0 else 0
    if skill["kind"] == "defend":
        amount = skill["shield_base"] + eff_stat(actor, "phys_res") * skill["shield_per_phys_res"]
        actor["shield"] += amount
        _log(state, "%s %s 방어막 %.1f" % (actor["name"], skill["name_ko"], amount))
        return
    resolve_attack(state, actor, pick_target(state, actor), skill_id)


def pick_target(state, actor):
    if actor["side"] == "ally":
        return state["enemy"]
    alive = [a for a in state["allies"] if a["alive"]]
    return state["rng"].choice(alive)   # 생존한 아군 전원에게 균등 무작위(4-12)


# ---------------------------------------------------------------- 라운드 진행

def _check_result(state):
    player = state["allies"][0]
    if not player["alive"]:
        state["result"] = "defeat"
    elif not state["enemy"]["alive"]:
        state["result"] = "victory"
    return state["result"]


def action_count(rules, actor):
    a = rules["actions"]
    actor["action_gauge"] += eff_stat(actor, "agility") * a["extra_per_agility"]
    extra = math.floor(actor["action_gauge"])
    actor["action_gauge"] -= extra
    return min(a["cap"], a["base"] + extra)


def take_turn(state, actor, forced_skill=None):
    """한 참가자의 턴. forced_skill 이 있으면 첫 행동에만 그 스킬(플레이어 수동 조작용)."""
    if not actor["alive"] or state["result"]:
        return
    actor["shield"] = 0.0   # 방어막은 다음 자기 턴 시작까지 유지 [임시 규칙]
    if actor["stunned"]:
        actor["stunned"] = False
        _log(state, "%s 기절로 행동 불가" % actor["name"])
        return
    for i in range(action_count(state["db"]["rules"], actor)):
        sid = forced_skill if (i == 0 and forced_skill) else choose_skill(state, actor)
        if sid is None or not skill_usable(state, actor, sid):
            break
        do_action(state, actor, sid)
        if _check_result(state):
            return


def end_of_round(state):
    rules = state["db"]["rules"]
    st = rules["status"]
    fighters = [a for a in state["allies"] if a["alive"]] + ([state["enemy"]] if state["enemy"]["alive"] else [])
    for c in fighters:
        for sid in list(c["status"].keys()):
            eff = c["status"][sid]
            dmg = eff["stacks"] * st[sid]["damage_per_stack"]
            if sid == "poison":
                factor = max(st["poison"]["min_factor"],
                             1 - eff_stat(c, st["poison"]["resist_stat"]) * st["poison"]["resist_per_point"])
                dmg *= factor
            if c["alive"]:
                _log(state, "%s %s 피해 %.1f" % (c["name"], sid, dmg))
                _lose_hp(state, c, dmg)
            eff["duration"] -= 1
            if eff["duration"] <= 0:
                del c["status"][sid]
    if _check_result(state):
        return
    for c in fighters:
        if not c["alive"]:
            continue
        heal = c["max_hp"] * rules["regen"]["pct_of_max_hp_per_point"] * max(0, eff_stat(c, "regen"))
        if "bleed" in c["status"]:
            heal *= rules["regen"]["bleed_heal_factor"]
        c["hp"] = min(c["max_hp"], c["hp"] + heal)
        c["spirit"] = min(c["max_spirit"], c["spirit"] + rules["spirit_regen_base"]
                          + eff_stat(c, "spirit_regen") * rules["spirit_regen_per_point"])
        for sid in list(c["cooldowns"].keys()):
            c["cooldowns"][sid] = max(0, c["cooldowns"][sid] - 1)


def run_round(state, player_skill=None):
    """한 라운드 진행. player_skill 을 주면 플레이어의 첫 행동을 수동으로 지정한다."""
    if state["result"]:
        return state["result"]
    state["round"] += 1
    for i, ally in enumerate(state["allies"]):
        take_turn(state, ally, player_skill if i == 0 else None)
        if state["result"]:
            return state["result"]
    take_turn(state, state["enemy"])
    if state["result"]:
        return state["result"]
    end_of_round(state)
    if not state["result"] and state["round"] >= state["db"]["rules"]["max_rounds"]:
        state["result"] = "timeout"
    return state["result"]


def run_combat(state):
    while not state["result"]:
        run_round(state)
    return summarize(state)


def summarize(state):
    player = state["allies"][0]
    return {
        "result": state["result"],
        "rounds": state["round"],
        "player_hp": max(0.0, player["hp"]),
        "instakill": state["instakill"],
        "enemy_incapacitated": state["enemy"]["incapacitated"],
    }
