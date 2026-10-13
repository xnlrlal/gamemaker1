"""밸런스 시뮬레이터.

예)
  python -m sim.simulate --race barbarian --weapon greatsword --enemy ghoul -n 2000
  python -m sim.simulate --matrix races          # 종족 x 1층 몬스터
  python -m sim.simulate --matrix weapons        # 성인식 무기 6종 x 1층 몬스터
  python -m sim.simulate --matrix floor2         # 바바리안 x 2층 몬스터
  python -m sim.simulate --matrix bestiary       # 몬스터 18종 x 바바리안(대검)
  python -m sim.simulate --log --enemy goblin    # 전투 로그 1판 출력
"""
import argparse

from .combat import new_combat, run_combat
from .db import load_db
from .entities import make_enemy, make_player


def simulate(db, race, weapon, enemy_id, n=1000, seed=1, mastery=0, policy=None):
    wins = deaths = insta = timeouts = 0
    rounds_total = hp_total = 0.0
    for i in range(n):
        player = make_player(db, race=race, weapon=weapon, vs_mastery=mastery)
        enemy = make_enemy(db, enemy_id)
        policies = {player["id"]: policy} if policy else None
        state = new_combat(db, [player], enemy, seed=seed * 1000003 + i, policies=policies)
        r = run_combat(state)
        rounds_total += r["rounds"]
        if r["result"] == "victory":
            wins += 1
            hp_total += r["player_hp"]
        elif r["result"] == "defeat":
            deaths += 1
            insta += 1 if r["instakill"] else 0
        else:
            timeouts += 1
    return {
        "n": n,
        "win_rate": wins / n,
        "avg_rounds": rounds_total / n,
        "avg_hp_left_on_win": hp_total / wins if wins else 0.0,
        "instakill_rate": insta / n,
        "timeout_rate": timeouts / n,
    }


def _table(title, row_labels, col_labels, cell):
    print("\n== %s ==  (승률 %%)" % title)
    print("%-14s" % "" + "".join("%12s" % c for c in col_labels))
    for r in row_labels:
        print("%-14s" % r + "".join("%12s" % cell(r, c) for c in col_labels))


def matrix(db, kind, n, seed, mastery, policy):
    floor1 = [m for m, v in db["monsters"].items() if v["floor"] == 1]
    floor2 = [m for m, v in db["monsters"].items() if v["floor"] == 2]
    name = lambda mid: db["monsters"][mid]["name_ko"]
    if kind == "races":
        rows = list(db["races"].keys())
        cols = floor1
        cell = lambda r, c: "%.1f" % (100 * simulate(db, r, "greatsword", c, n, seed, mastery, policy)["win_rate"])
        _table("종족 x 1층 (대검)", [db["races"][r]["name_ko"] + "/" + r for r in rows], [name(c) for c in cols],
               lambda r, c: cell(r.split("/")[1], [k for k in cols if name(k) == c][0]))
    elif kind == "weapons":
        rows = list(db["equipment"]["weapons"].keys())
        _table("바바리안 무기 x 1층", rows, [name(c) for c in floor1],
               lambda r, c: "%.1f" % (100 * simulate(db, "barbarian", r, [k for k in floor1 if name(k) == c][0],
                                                     n, seed, mastery, policy)["win_rate"]))
    elif kind == "floor2":
        rows = list(db["equipment"]["weapons"].keys())
        _table("바바리안 무기 x 2층", rows, [name(c) for c in floor2],
               lambda r, c: "%.1f" % (100 * simulate(db, "barbarian", r, [k for k in floor2 if name(k) == c][0],
                                                     n, seed, mastery, policy)["win_rate"]))
    elif kind == "bestiary":
        bestiary(db, n, seed, mastery, policy)
    else:
        raise SystemExit("unknown matrix: %s" % kind)


def bestiary(db, n, seed, mastery, policy, race="barbarian", weapon="greatsword"):
    print("\n== 도감 x %s(%s)  n=%d, 숙련 %d ==" % (race, weapon, n, mastery))
    print("%-16s %4s %7s %7s %9s %6s  %s" % ("몬스터", "등급", "승률%", "라운드", "남은HP", "즉사%", "스킬"))
    for mid, m in db["monsters"].items():
        r = simulate(db, race, weapon, mid, n, seed, mastery, policy)
        skills = m.get("skills", db["monster_defaults"]["skills"])
        print("%-16s %4d %7.1f %7.1f %9.1f %6.1f  %s" % (
            m["name_ko"], m["grade"], 100 * r["win_rate"], r["avg_rounds"],
            r["avg_hp_left_on_win"], 100 * r["instakill_rate"],
            ",".join(db["skills"][k]["name_ko"] for k in skills)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=None)
    ap.add_argument("--race", default="barbarian")
    ap.add_argument("--weapon", default="greatsword")
    ap.add_argument("--enemy", default="goblin")
    ap.add_argument("-n", type=int, default=1000)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--mastery", type=int, default=0)
    ap.add_argument("--policy", default=None, help="highest_value / attack_only / random")
    ap.add_argument("--matrix", default=None, help="races / weapons / floor2 / bestiary")
    ap.add_argument("--log", action="store_true", help="전투 1판의 로그 출력")
    args = ap.parse_args()
    db = load_db(args.db)

    if args.log:
        player = make_player(db, race=args.race, weapon=args.weapon, vs_mastery=args.mastery)
        enemy = make_enemy(db, args.enemy)
        state = new_combat(db, [player], enemy, seed=args.seed,
                           policies={player["id"]: args.policy} if args.policy else None)
        r = run_combat(state)
        print("\n".join(state["log"]))
        print(r)
        return
    if args.matrix:
        matrix(db, args.matrix, args.n, args.seed, args.mastery, args.policy)
        return
    r = simulate(db, args.race, args.weapon, args.enemy, args.n, args.seed, args.mastery, args.policy)
    print("%s(%s) vs %s  n=%d" % (args.race, args.weapon, args.enemy, r["n"]))
    for k, v in r.items():
        if k != "n":
            print("  %-20s %.3f" % (k, v))


if __name__ == "__main__":
    main()
