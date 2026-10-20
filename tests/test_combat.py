import copy
import unittest

from sim import combat
from sim.combat import new_combat, run_combat, run_round
from sim.db import DbError, load_db, validate_db
from sim.entities import eff_stat, make_enemy, make_player, monster_stats_from_grade

BASE_DB = load_db()


def fresh(enemy_id="goblin", seed=1, db=None, **player_kw):
    db = db or copy.deepcopy(BASE_DB)
    player = make_player(db, **player_kw)
    enemy = make_enemy(db, enemy_id)
    return db, player, enemy, new_combat(db, [player], enemy, seed=seed)


class DbTests(unittest.TestCase):
    def test_default_db_is_valid(self):
        validate_db(BASE_DB)

    def test_unknown_skill_reference_rejected(self):
        bad = copy.deepcopy(BASE_DB)
        bad["monster_defaults"]["skills"] = ["nope"]
        with self.assertRaises(DbError):
            validate_db(bad)

    def test_monster_count(self):
        self.assertEqual(len(BASE_DB["monsters"]), 18)


class MonsterGradeTests(unittest.TestCase):
    def test_grade_formula(self):
        f = lambda g: monster_stats_from_grade(BASE_DB, g)
        self.assertEqual(f(9), {"strength": 0, "phys_res": 0})
        self.assertEqual(f(6), {"strength": 3, "phys_res": 6})            # 6등급은 아직 재생 없음
        self.assertEqual(f(5), {"strength": 4, "phys_res": 8, "regen": 2})
        self.assertEqual(f(1), {"strength": 8, "phys_res": 16, "regen": 10})

    def test_overrides(self):
        ghoul = make_enemy(BASE_DB, "ghoul")
        self.assertEqual(eff_stat(ghoul, "strength"), 3)
        self.assertEqual(eff_stat(ghoul, "agility"), 1)
        self.assertEqual(eff_stat(make_enemy(BASE_DB, "goblin_archer"), "strength"), 1)
        gnome = make_enemy(BASE_DB, "gnome")
        self.assertEqual(eff_stat(gnome, "strength"), -2)
        self.assertEqual(eff_stat(gnome, "phys_res"), 4)


class PlayerBuildTests(unittest.TestCase):
    def test_barbarian_with_greatsword_and_starter_armor(self):
        p = make_player(BASE_DB, "barbarian", "greatsword")
        self.assertEqual(eff_stat(p, "strength"), 6)       # 3 + 대검 3
        self.assertEqual(eff_stat(p, "phys_res"), 3)       # 천 상의 1 + 천 하의 2
        self.assertEqual(eff_stat(p, "regen"), 4)          # 2 + 샌들 2
        self.assertEqual(p["max_spirit"], 20)
        self.assertEqual(p["max_hp"], 100)

    def test_mastery_bonus_is_capped(self):
        p = make_player(BASE_DB, vs_mastery=5)
        base = make_player(BASE_DB)
        self.assertEqual(eff_stat(p, "accuracy") - eff_stat(base, "accuracy"), 2)
        self.assertEqual(eff_stat(p, "phys_res") - eff_stat(base, "phys_res"), 2)


class JudgementTests(unittest.TestCase):
    def test_hit_chance_is_clamped(self):
        db, p, e, st = fresh()
        rules = db["rules"]
        p["base_stats"]["accuracy"] = 1000
        self.assertEqual(combat.hit_chance(rules, p, e), rules["hit"]["max"])
        p["base_stats"]["accuracy"] = 0
        e["base_stats"]["flexibility"] = 1000
        self.assertEqual(combat.hit_chance(rules, p, e), rules["hit"]["min"])

    def test_mitigation_has_cap(self):
        db, p, e, st = fresh()
        p["base_stats"]["phys_res"] = 1000
        self.assertEqual(combat.mitigation(db["rules"], p), db["rules"]["mitigation"]["cap"])

    def test_instakill_chance(self):
        rules = BASE_DB["rules"]
        c = lambda mid: combat.instakill_chance(rules, make_enemy(BASE_DB, mid))
        self.assertEqual(c("goblin"), 0.0)                       # 가장 약한 근접은 불가능
        self.assertAlmostEqual(c("goblin_archer"), 0.01)         # 원거리 추가
        self.assertAlmostEqual(c("deathfiend"), 3 * 0.002)       # 6등급 근접
        self.assertEqual(combat.instakill_chance(rules, make_player(BASE_DB)), 0.0)

    def test_instakill_cap(self):
        rules = copy.deepcopy(BASE_DB["rules"])
        rules["instakill"]["cap"] = 0.005
        self.assertEqual(combat.instakill_chance(rules, make_enemy(BASE_DB, "deathfiend")), 0.005)

    def test_instakill_only_targets_player_and_ends_combat(self):
        db = copy.deepcopy(BASE_DB)
        db["rules"]["instakill"].update({"per_grade_step": 1.0, "cap": 1.0})
        db["rules"]["hit"].update({"base": 1.0, "min": 1.0, "max": 1.0})
        db, p, e, st = fresh("deathfiend", db=db)
        run_round(st)
        run_round(st)
        self.assertEqual(st["result"], "defeat")
        self.assertTrue(st["instakill"])

    def test_damage_pipeline_numbers(self):
        # 명중·치명 고정: 베기(10) x (1 + 근력6*0.1) = 16, 몬스터 9등급 물리내성 0
        db = copy.deepcopy(BASE_DB)
        db["rules"]["hit"].update({"base": 1.0, "min": 1.0, "max": 1.0})
        db["rules"]["crit"].update({"base": 0.0, "max": 0.0})
        db["rules"]["part_damage"]["chance"] = 0.0
        del db["monsters"]["gnome"]["stat_override"]  # 노움 개별 보정을 빼 순수 9등급 기준으로 계산
        db, p, e, st = fresh("gnome", db=db)
        combat.do_action(st, p, "slash")
        self.assertAlmostEqual(e["hp"], 100 - 16)

    def test_mitigation_reduces_damage(self):
        db = copy.deepcopy(BASE_DB)
        db["rules"]["hit"].update({"base": 1.0, "min": 1.0, "max": 1.0})
        db["rules"]["crit"].update({"base": 0.0, "max": 0.0})
        db["rules"]["part_damage"]["chance"] = 0.0
        db, p, e, st = fresh("deathfiend", db=db)       # 6등급: 물리내성 6 -> 12% 경감
        combat.do_action(st, p, "slash")
        self.assertAlmostEqual(e["hp"], 100 - 16 * 0.88)

    def test_shield_absorbs_before_hp(self):
        c = make_player(BASE_DB)
        c["shield"] = 5.0
        self.assertEqual(combat._absorb_with_shield(c, 8.0), 3.0)
        self.assertEqual(c["shield"], 0.0)
        c["shield"] = 20.0
        self.assertEqual(combat._absorb_with_shield(c, 8.0), 0.0)
        self.assertEqual(c["shield"], 12.0)

    def test_guard_shield_scales_with_phys_res(self):
        db, p, e, st = fresh()
        combat.do_action(st, p, "guard")
        self.assertAlmostEqual(p["shield"], 8 + 3 * 2.0)      # 물리내성 3

    def test_shield_expires_on_own_next_turn(self):
        db, p, e, st = fresh()
        p["shield"] = 7.0
        p["cooldowns"]["guard"] = 5          # 이번 턴에 새 방어막을 치지 못하게 막는다
        combat.take_turn(st, p)
        self.assertEqual(p["shield"], 0.0)


class CooldownAndSpiritTests(unittest.TestCase):
    def test_cooldown_blocks_exactly_n_rounds(self):
        db, p, e, st = fresh()
        combat.do_action(st, p, "smash")                  # 1라운드에 사용, 쿨타임 3
        blocked = []
        for _ in range(4):                                # 2·3·4·5라운드 시작 시점
            combat.end_of_round(st)
            p["spirit"] = p["max_spirit"]
            blocked.append(not combat.skill_usable(st, p, "smash"))
        self.assertEqual(blocked, [True, True, True, False])   # 2~4라운드 사용 불가, 5라운드 가능

    def test_cooldown_zero_skill_has_no_restriction(self):
        db, p, e, st = fresh()
        combat.do_action(st, p, "slash")
        self.assertTrue(combat.skill_usable(st, p, "slash"))     # 같은 라운드에도 다시 가능(행동 횟수·영혼력만 제한)

    def test_extra_actions_let_fast_monster_repeat_cooldown_zero_skill(self):
        db, p, e, st = fresh("ghoul")
        e["skills"] = ["slash"]
        e["action_gauge"] = 1.0                                   # 이번 라운드 추가 행동 1회 확보
        spirit = e["spirit"]
        combat.take_turn(st, e)
        self.assertEqual(spirit - e["spirit"], 2 * db["skills"]["slash"]["cost"])

    def test_spirit_gates_skills(self):
        db, p, e, st = fresh()
        p["spirit"] = 2.0
        self.assertEqual(combat.usable_skills(st, p), [])
        p["spirit"] = 3.0
        self.assertEqual(set(combat.usable_skills(st, p)), {"slash", "guard"})

    def test_spirit_recovers_partially_each_round(self):
        db, p, e, st = fresh()
        p["spirit"] = 0.0
        combat.end_of_round(st)
        self.assertAlmostEqual(p["spirit"], 2.0)
        p["spirit"] = 19.5
        combat.end_of_round(st)
        self.assertAlmostEqual(p["spirit"], 20.0)         # 최대치 초과 불가


class ActionCountTests(unittest.TestCase):
    def test_default_one_action(self):
        db, p, e, st = fresh()
        self.assertEqual([combat.action_count(db["rules"], p) for _ in range(5)], [1] * 5)

    def test_agility_adds_actions_with_cap(self):
        db, p, e, st = fresh("ghoul")
        e["base_stats"]["agility"] = 3
        e["stat_override"] = {"agility": 3}
        total = sum(combat.action_count(db["rules"], e) for _ in range(10))   # 민첩성 3 -> 라운드당 +0.6
        self.assertIn(total, (15, 16))
        e["base_stats"]["agility"] = 1000
        self.assertEqual(combat.action_count(db["rules"], e), db["rules"]["actions"]["cap"])


class StatusTests(unittest.TestCase):
    def test_duplicate_status_stacks_and_keeps_longer_duration(self):
        db, p, e, st = fresh()
        combat.apply_status(st, e, "bleed", 1, 3)
        combat.apply_status(st, e, "bleed", 1, 2)
        self.assertEqual(e["status"]["bleed"], {"stacks": 2, "duration": 3})   # 합산이 아니다
        combat.apply_status(st, e, "bleed", 1, 5)
        self.assertEqual(e["status"]["bleed"]["duration"], 5)

    def test_stack_cap(self):
        db, p, e, st = fresh()
        combat.apply_status(st, e, "poison", 99, 3)
        self.assertEqual(e["status"]["poison"]["stacks"], db["rules"]["status"]["poison"]["stack_cap"])

    def test_bleed_ticks_and_expires(self):
        db, p, e, st = fresh()
        combat.apply_status(st, e, "bleed", 2, 2)
        combat.end_of_round(st)
        self.assertAlmostEqual(e["hp"], 100 - 4.0)
        combat.end_of_round(st)
        self.assertNotIn("bleed", e["status"])
        self.assertAlmostEqual(e["hp"], 100 - 8.0)

    def test_poison_resistance_reduces_but_never_immune(self):
        db, p, e, st = fresh()
        p["hp"] = 50.0
        combat.apply_status(st, p, "poison", 1, 3)
        combat.end_of_round(st)                          # 독 2.0 피해 후 자연재생 +2.0
        self.assertAlmostEqual(p["hp"], 50.0)
        p["hp"] = 50.0
        p["status"].clear()
        p["base_stats"]["poison_res"] = 1000
        combat.apply_status(st, p, "poison", 1, 3)
        combat.end_of_round(st)                          # 최소 계수 0.2 -> 독 0.4, 면역은 없다
        self.assertAlmostEqual(p["hp"], 50.0 - 0.4 + 2.0)

    def test_bleed_halves_natural_regen(self):
        db, p, e, st = fresh()
        p["hp"] = 50.0
        combat.end_of_round(st)                          # 재생 4pt x 0.5% x 100 = 2.0
        self.assertAlmostEqual(p["hp"], 52.0)
        p["hp"] = 50.0
        p["status"]["bleed"] = {"stacks": 0, "duration": 5}
        combat.end_of_round(st)
        self.assertAlmostEqual(p["hp"], 51.0)

    def test_stun_blocks_exactly_one_turn(self):
        db, p, e, st = fresh()
        combat.apply_status(st, p, "stun", 1, 1)
        self.assertTrue(p["stunned"])
        spirit = p["spirit"]
        combat.take_turn(st, p)
        self.assertEqual(p["spirit"], spirit)            # 행동 못 함
        self.assertFalse(p["stunned"])
        combat.take_turn(st, p)
        self.assertLess(p["spirit"], spirit)             # 다음 턴은 정상


class PartDamageTests(unittest.TestCase):
    def _forced(self, parts=None):
        db = copy.deepcopy(BASE_DB)
        db["rules"]["part_damage"]["chance"] = 1.0
        if parts:
            db["rules"]["part_damage"]["parts"] = parts
        return fresh(db=db)

    def test_each_part_is_damaged_once_per_combat(self):
        db, p, e, st = self._forced()
        for _ in range(12):
            combat._damage_part(st, p)
        self.assertEqual(sorted(p["damaged_parts"]), sorted(db["rules"]["part_damage"]["parts"]))
        self.assertEqual(len(p["damaged_parts"]), 5)
        self.assertEqual(p["part_penalty"], {"regen": -3, "accuracy": -6, "flexibility": -6})

    def test_part_penalties_affect_effective_stats(self):
        db, p, e, st = self._forced(["left_arm"])
        before = eff_stat(p, "accuracy")
        combat._damage_part(st, p)
        self.assertEqual(eff_stat(p, "accuracy"), before - 3)

    def test_torso_damage_wears_top_and_it_disappears_at_zero(self):
        db = copy.deepcopy(BASE_DB)
        db["rules"]["part_damage"].update({"chance": 1.0, "parts": ["torso"], "durability_loss": 15})
        db, p, e, st = fresh(db=db)
        before = eff_stat(p, "phys_res")
        combat._damage_part(st, p)
        top = [g for g in p["gear"] if g["slot"] == "top"][0]
        self.assertEqual(top["durability"], 0)
        self.assertEqual(eff_stat(p, "phys_res"), before - 1)    # 천 상의 물리내성 +1 소실

    def test_leg_damage_wears_shoes(self):
        db = copy.deepcopy(BASE_DB)
        db["rules"]["part_damage"].update({"chance": 1.0, "parts": ["left_leg"], "durability_loss": 6})
        db, p, e, st = fresh(db=db)
        before = eff_stat(p, "regen")
        combat._damage_part(st, p)
        self.assertEqual(eff_stat(p, "regen"), before - 2)       # 샌들 자연재생 +2 소실


class MonsterSkillTests(unittest.TestCase):
    def test_every_monster_has_valid_skills_and_ai(self):
        for mid in BASE_DB["monsters"]:
            m = make_enemy(BASE_DB, mid)
            self.assertTrue(m["skills"], mid)
            for sid in m["skills"]:
                self.assertIn(sid, BASE_DB["skills"])
            self.assertIn(m["ai"], combat.POLICIES)

    def test_player_only_gets_the_four_basic_skills(self):
        p = make_player(BASE_DB)
        self.assertEqual(sorted(p["skills"]), ["guard", "pierce", "slash", "smash"])

    def test_ranged_monsters_use_shot_skills(self):
        for mid in ("goblin_archer", "skeleton_archer"):
            self.assertTrue(make_enemy(BASE_DB, mid)["ranged"])
            self.assertIn("shoot", make_enemy(BASE_DB, mid)["skills"])

    def test_on_hit_chance_zero_never_and_one_always_applies(self):
        db = copy.deepcopy(BASE_DB)
        db["rules"]["hit"].update({"base": 1.0, "min": 1.0, "max": 1.0})
        db["rules"]["part_damage"]["chance"] = 0.0
        db["skills"]["bash"] = {"name_ko": "t", "kind": "attack", "power": 1, "cost": 0, "cooldown": 0,
                                "on_hit": [{"status": "bleed", "chance": 1.0}]}
        db, p, e, st = fresh("gnome", db=db)
        combat.resolve_attack(st, p, e, "bash")
        self.assertIn("bleed", e["status"])
        db["skills"]["bash"]["on_hit"][0]["chance"] = 0.0001
        db2, p2, e2, st2 = fresh("gnome", db=db, seed=3)
        combat.resolve_attack(st2, p2, e2, "bash")
        self.assertNotIn("bleed", e2["status"])

    def test_invalid_on_hit_chance_rejected(self):
        bad = copy.deepcopy(BASE_DB)
        bad["skills"]["bite"]["on_hit"][0]["chance"] = 1.5
        with self.assertRaises(DbError):
            validate_db(bad)

    def test_guard_when_hurt_policy(self):
        db, p, e, st = fresh("skeleton_warrior")
        self.assertEqual(e["ai"], "guard_when_hurt")
        self.assertEqual(combat.choose_skill(st, e), "slash")         # 건강할 땐 공격
        e["hp"] = 30.0
        self.assertEqual(combat.choose_skill(st, e), "guard")         # 다치면 방어
        e["cooldowns"]["guard"] = 2
        self.assertEqual(combat.choose_skill(st, e), "slash")         # 방어가 쿨타임이면 공격

    def test_actor_policy_override_beats_monster_ai(self):
        db, p, e, st = fresh("skeleton_warrior")
        st["policies"][e["id"]] = "random"
        e["hp"] = 30.0
        picks = {combat.choose_skill(st, e) for _ in range(60)}
        self.assertEqual(picks, {"slash", "guard"})


class HumanoidTests(unittest.TestCase):
    def test_humanoid_npc_is_incapacitated_not_killed(self):
        db, p, e, st = fresh("wanderer")
        combat._lose_hp(st, e, 1000)
        self.assertTrue(e["incapacitated"])
        self.assertFalse(e["alive"])
        self.assertEqual(combat._check_result(st), "victory")

    def test_monster_just_dies(self):
        db, p, e, st = fresh("goblin")
        combat._lose_hp(st, e, 1000)
        self.assertFalse(e["incapacitated"])


class CombatFlowTests(unittest.TestCase):
    def test_same_seed_same_result(self):
        r1 = run_combat(fresh("ghoul", seed=42)[3])
        r2 = run_combat(fresh("ghoul", seed=42)[3])
        self.assertEqual(r1, r2)

    def test_all_combats_terminate_with_sane_state(self):
        for enemy_id in list(BASE_DB["monsters"]) + ["wanderer"]:
            for seed in range(30):
                db, p, e, st = fresh(enemy_id, seed=seed)
                r = run_combat(st)
                self.assertIn(r["result"], ("victory", "defeat", "timeout"))
                self.assertLessEqual(r["rounds"], db["rules"]["max_rounds"])
                self.assertGreaterEqual(p["spirit"], 0.0)
                self.assertLessEqual(p["hp"], p["max_hp"])

    def test_player_defeat_ends_combat(self):
        db, p, e, st = fresh()
        combat._lose_hp(st, p, 1000)
        self.assertEqual(combat._check_result(st), "defeat")
        self.assertEqual(run_round(st), "defeat")

    def test_manual_skill_is_used_first(self):
        db, p, e, st = fresh()
        run_round(st, player_skill="smash")
        self.assertEqual(p["cooldowns"]["smash"], 3)     # 사용 직후 +1 되고 라운드 종료 때 1 깎임

    def test_companion_falls_without_ending_combat(self):
        db = copy.deepcopy(BASE_DB)
        player = make_player(db)
        ally = make_player(db, race="human", name="동료")
        ally["id"] = "ally1"
        enemy = make_enemy(db, "goblin")
        st = new_combat(db, [player, ally], enemy, seed=1)
        combat._lose_hp(st, ally, 1000)
        self.assertIsNone(combat._check_result(st))
        self.assertNotEqual(run_round(st), "defeat")

    def test_enemy_targets_only_living_allies(self):
        db = copy.deepcopy(BASE_DB)
        player, ally = make_player(db), make_player(db, race="human", name="동료")
        ally["id"] = "ally1"
        st = new_combat(db, [player, ally], make_enemy(db, "goblin"), seed=1)
        ally["alive"] = False
        for _ in range(20):
            self.assertIs(combat.pick_target(st, st["enemy"]), player)

    def test_policy_attack_only_never_defends(self):
        db, p, e, st = fresh()
        st["policies"][p["id"]] = "attack_only"
        for _ in range(30):
            sid = combat.choose_skill(st, p)
            self.assertNotEqual(db["skills"][sid]["kind"] if sid else "attack", "defend")
            p["spirit"] = p["max_spirit"]


if __name__ == "__main__":
    unittest.main()
