"""고정 수치 DB(SQLite) 도구: db.json <-> data/dungeon_stone.db.

    python3 scripts/db_tool.py build [json] [db]    # db.json -> SQLite (db 는 덮어씀)
    python3 scripts/db_tool.py export [db] [json]   # SQLite -> JSON (기본 출력은 stdout)
    python3 scripts/db_tool.py check                # 커밋된 .db 가 db.json 과 같은 내용인지 점검

표 구성(정규화: 칸마다 값 하나, 목록·중첩은 자식 표, 참조는 외래키):
  스탯 stats · 상태이상 statuses/status_penalties · 부위 parts · 구역 zones · 등급 grades · 레벨 level_exp
  스킬 skills/skill_effects · 종족 races/race_substats/starter_armor · 장비 items/item_bonuses
  몬스터 monsters/monster_stats/monster_skills/monster_default_* · NPC npcs/npc_stats/npc_skills
  기본 스킬 player_skills · 층별 무리 크기 floor_group_sizes
그 밖의 단일 수치(rules·dungeon·economy 등)는 settings(path, value) 에 'rules.hit.base' 같은
점 경로로 한 칸씩 저장한다.
db.json 에서 DB 로 갔다가 되돌려도 내용이 같다(키 순서는 ORDER 기준).
"""
import copy
import json
import os
import sqlite3
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JSON_PATH = os.path.join(ROOT, "data", "db.json")
DB_PATH = os.path.join(ROOT, "data", "dungeon_stone.db")

ORDER = ["meta", "status_names", "part_names", "stat_names", "zone_names", "dungeon", "economy",
         "progression", "rules", "player_default_skills", "skills", "races", "equipment", "monsters",
         "monster_defaults", "npcs"]
RACE_STATS = ("spirit", "body", "mind", "psychic", "strength", "phys_res", "regen", "smell")
MAIN_STATS = ("body", "mind", "psychic")
# 스탯 분류(기획서 5-2): main = 메인스탯, 나머지는 세부스탯이 속한 메인스탯
STAT_GROUPS = {"body": "main", "mind": "main", "psychic": "main",
               "strength": "body", "phys_res": "body", "regen": "body", "smell": "body",
               "accuracy": "body", "flexibility": "body", "agility": "body", "spirit": "psychic"}
ITEM_GROUPS = ("weapons", "armor")
SKILL_FIELDS = {"name_ko", "kind", "cost", "cooldown", "power", "range", "shield_base", "shield_per_phys_res", "on_hit"}
EFFECT_FIELDS = {"status", "chance", "stacks", "duration"}
STATUS_FIELDS = {"damage_per_stack", "stack_cap", "resist_stat", "resist_per_point", "min_factor", "max_resist",
                 "stat_penalty"}
MONSTER_FIELDS = {"name_ko", "grade", "floor", "zone", "ranged", "stat_override", "skills", "ai", "dark_bonus"}
STATUS_COLS = ("damage_per_stack", "stack_cap", "resist_stat", "resist_per_point", "min_factor", "max_resist")

SCHEMA = """
CREATE TABLE settings (path TEXT PRIMARY KEY, seq INTEGER NOT NULL, value TEXT NOT NULL);
CREATE TABLE stats (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, name_ko TEXT NOT NULL, grp TEXT NOT NULL);
CREATE TABLE zones (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, name_ko TEXT NOT NULL);
CREATE TABLE statuses (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, name_ko TEXT NOT NULL,
    damage_per_stack REAL, stack_cap INTEGER, resist_stat TEXT, resist_per_point REAL, min_factor REAL,
    max_resist REAL);
CREATE TABLE status_penalties (status_id TEXT NOT NULL REFERENCES statuses(id),
    stat_id TEXT NOT NULL REFERENCES stats(id), delta REAL NOT NULL, PRIMARY KEY (status_id, stat_id));
CREATE TABLE parts (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, name_ko TEXT NOT NULL,
    effect_stat TEXT NOT NULL REFERENCES stats(id), effect_delta REAL NOT NULL, gear_slot TEXT);
CREATE TABLE grades (grade INTEGER PRIMARY KEY, exchange_rate INTEGER NOT NULL, exp INTEGER NOT NULL);
CREATE TABLE level_exp (level INTEGER PRIMARY KEY, exp INTEGER NOT NULL);
CREATE TABLE floor_group_sizes (floor INTEGER NOT NULL, day INTEGER NOT NULL, size INTEGER NOT NULL,
    PRIMARY KEY (floor, day));
CREATE TABLE skills (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, name_ko TEXT NOT NULL, kind TEXT NOT NULL,
    cost INTEGER NOT NULL, cooldown INTEGER NOT NULL, power REAL, attack_range INTEGER,
    shield_base REAL, shield_per_phys_res REAL);
CREATE TABLE skill_effects (skill_id TEXT NOT NULL REFERENCES skills(id), seq INTEGER NOT NULL,
    status_id TEXT NOT NULL REFERENCES statuses(id), chance REAL, stacks INTEGER, duration INTEGER,
    PRIMARY KEY (skill_id, seq));
CREATE TABLE player_skills (seq INTEGER PRIMARY KEY, skill_id TEXT NOT NULL REFERENCES skills(id));
CREATE TABLE races (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, name_ko TEXT NOT NULL,
    body REAL NOT NULL, mind REAL NOT NULL, psychic REAL NOT NULL);
CREATE TABLE race_substats (race_id TEXT NOT NULL REFERENCES races(id), stat_id TEXT NOT NULL REFERENCES stats(id),
    value REAL NOT NULL, PRIMARY KEY (race_id, stat_id));
CREATE TABLE items (id TEXT PRIMARY KEY, category TEXT NOT NULL, seq INTEGER NOT NULL, name_ko TEXT NOT NULL,
    desc TEXT NOT NULL, slot TEXT NOT NULL, attack_range INTEGER, durability INTEGER);
CREATE TABLE item_bonuses (item_id TEXT NOT NULL REFERENCES items(id), stat_id TEXT NOT NULL REFERENCES stats(id),
    value REAL NOT NULL, PRIMARY KEY (item_id, stat_id));
CREATE TABLE starter_armor (race_id TEXT NOT NULL REFERENCES races(id), seq INTEGER NOT NULL,
    item_id TEXT NOT NULL REFERENCES items(id), PRIMARY KEY (race_id, seq));
CREATE TABLE monsters (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, name_ko TEXT NOT NULL,
    grade INTEGER NOT NULL REFERENCES grades(grade), floor INTEGER NOT NULL,
    zone TEXT NOT NULL REFERENCES zones(id), ranged INTEGER NOT NULL, ai TEXT, dark_aggro_radius INTEGER);
CREATE TABLE monster_stats (monster_id TEXT NOT NULL REFERENCES monsters(id),
    kind TEXT NOT NULL CHECK (kind IN ('override', 'dark')), stat_id TEXT NOT NULL REFERENCES stats(id),
    value REAL NOT NULL, PRIMARY KEY (monster_id, kind, stat_id));
CREATE TABLE monster_skills (monster_id TEXT NOT NULL REFERENCES monsters(id), seq INTEGER NOT NULL,
    skill_id TEXT NOT NULL REFERENCES skills(id), PRIMARY KEY (monster_id, seq));
CREATE TABLE monster_default_stats (stat_id TEXT PRIMARY KEY REFERENCES stats(id), value REAL NOT NULL);
CREATE TABLE monster_default_skills (seq INTEGER PRIMARY KEY, skill_id TEXT NOT NULL REFERENCES skills(id));
CREATE TABLE npcs (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, name_ko TEXT NOT NULL, humanoid INTEGER NOT NULL,
    ranged INTEGER NOT NULL);
CREATE TABLE npc_stats (npc_id TEXT NOT NULL REFERENCES npcs(id), stat_id TEXT NOT NULL REFERENCES stats(id),
    value REAL NOT NULL, PRIMARY KEY (npc_id, stat_id));
CREATE TABLE npc_skills (npc_id TEXT NOT NULL REFERENCES npcs(id), seq INTEGER NOT NULL,
    skill_id TEXT NOT NULL REFERENCES skills(id), PRIMARY KEY (npc_id, seq));
"""


def dumps(v):
    return json.dumps(v, ensure_ascii=False)


def flatten(prefix, value, out):
    if isinstance(value, dict) and value:
        for k, v in value.items():
            if "." in k:
                raise ValueError("key with '.' is not allowed: %s.%s" % (prefix, k))
            flatten(prefix + "." + k, v, out)
    else:
        out.append((prefix, value))


def pop(node, path):
    """점 경로(a.b.c)의 값을 떼어 돌려준다."""
    keys = path.split(".")
    for k in keys[:-1]:
        node = node[k]
    return node.pop(keys[-1])


def put(node, path, value):
    keys = path.split(".")
    for k in keys[:-1]:
        node = node.setdefault(k, {})
    node[keys[-1]] = value


def check_keys(what, obj, allowed):
    extra = set(obj) - allowed
    if extra:
        raise ValueError("%s: unexpected fields %s" % (what, sorted(extra)))


def build(db, path):
    if os.path.exists(path):
        os.remove(path)
    rest = copy.deepcopy(db)
    con = sqlite3.connect(path)
    con.executescript(SCHEMA)
    con.execute("PRAGMA foreign_keys=ON")
    many = con.executemany

    for i, (stat, name) in enumerate(pop(rest, "stat_names").items()):
        if stat not in STAT_GROUPS:
            raise ValueError("stat %s: no group in STAT_GROUPS" % stat)
        con.execute("INSERT INTO stats VALUES (?,?,?,?)", (stat, i, name, STAT_GROUPS[stat]))
    many("INSERT INTO zones VALUES (?,?,?)", [(z, i, n) for i, (z, n) in enumerate(pop(rest, "zone_names").items())])

    status_rules = pop(rest, "rules.status")
    status_names = pop(rest, "status_names")
    if set(status_rules) != set(status_names):
        raise ValueError("status_names and rules.status differ")
    for i, (sid, name) in enumerate(status_names.items()):
        r = status_rules[sid]
        check_keys("status " + sid, r, STATUS_FIELDS)
        con.execute("INSERT INTO statuses VALUES (?,?,?,?,?,?,?,?,?)",
                    (sid, i, name) + tuple(r.get(k) for k in STATUS_COLS))
        many("INSERT INTO status_penalties VALUES (?,?,?)",
             [(sid, k, v) for k, v in r.get("stat_penalty", {}).items()])

    part_names = pop(rest, "part_names")
    parts, effects, gear = (pop(rest, "rules.part_damage." + k) for k in ("parts", "effects", "gear_slot"))
    if not (list(part_names) == parts == list(effects)) or set(gear) - set(parts):
        raise ValueError("part_names, part_damage.parts/effects/gear_slot differ")
    for i, pid in enumerate(parts):
        con.execute("INSERT INTO parts VALUES (?,?,?,?,?,?)",
                    (pid, i, part_names[pid], effects[pid]["stat"], effects[pid]["delta"], gear.get(pid)))

    rates = pop(rest, "economy.exchange_rate_by_grade")
    exps = pop(rest, "progression.exp_by_grade")
    if set(rates) != set(exps):
        raise ValueError("exchange_rate_by_grade and exp_by_grade differ")
    many("INSERT INTO grades VALUES (?,?,?)", [(int(g), rates[g], exps[g]) for g in rates])
    many("INSERT INTO level_exp VALUES (?,?)", list(enumerate(pop(rest, "progression.exp_to_level"))))
    for fk, fl in rest["dungeon"].items():
        if isinstance(fl, dict) and "group_by_day" in fl:
            many("INSERT INTO floor_group_sizes VALUES (?,?,?)",
                 [(int(fk[5:]), day + 1, n) for day, n in enumerate(fl.pop("group_by_day"))])

    for i, (sid, sk) in enumerate(db["skills"].items()):
        check_keys("skill " + sid, sk, SKILL_FIELDS)
        con.execute("INSERT INTO skills VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (sid, i, sk["name_ko"], sk["kind"], sk["cost"], sk["cooldown"], sk.get("power"),
                     sk.get("range"), sk.get("shield_base"), sk.get("shield_per_phys_res")))
        for j, ef in enumerate(sk.get("on_hit", [])):
            check_keys("skill %s on_hit" % sid, ef, EFFECT_FIELDS)
            con.execute("INSERT INTO skill_effects VALUES (?,?,?,?,?,?)",
                        (sid, j, ef["status"], ef.get("chance"), ef.get("stacks"), ef.get("duration")))
    many("INSERT INTO player_skills VALUES (?,?)", list(enumerate(pop(rest, "player_default_skills"))))

    for i, (rid, r) in enumerate(db["races"].items()):
        if set(r["stats"]) != set(RACE_STATS) or set(r) != {"name_ko", "stats"}:
            raise ValueError("race %s: unexpected fields" % rid)
        con.execute("INSERT INTO races VALUES (?,?,?,?,?,?)",
                    (rid, i, r["name_ko"]) + tuple(r["stats"][k] for k in MAIN_STATS))
        many("INSERT INTO race_substats VALUES (?,?,?)",
             [(rid, k, r["stats"][k]) for k in RACE_STATS if k not in MAIN_STATS and r["stats"][k]])

    for group in ITEM_GROUPS:
        for i, (iid, it) in enumerate(db["equipment"][group].items()):
            want = {"name_ko", "desc", "slot", "bonuses"} | ({"range"} if group == "weapons" else {"durability"})
            if set(it) != want:
                raise ValueError("item %s: unexpected fields" % iid)
            con.execute("INSERT INTO items VALUES (?,?,?,?,?,?,?,?)",
                        (iid, group, i, it["name_ko"], it["desc"], it["slot"], it.get("range"), it.get("durability")))
            many("INSERT INTO item_bonuses VALUES (?,?,?)", [(iid, k, v) for k, v in it["bonuses"].items()])
    equipment = rest.pop("equipment")
    for k, v in equipment.items():
        if k in ITEM_GROUPS:
            continue
        if not k.endswith("_starter_armor"):
            raise ValueError("equipment.%s: unexpected" % k)
        many("INSERT INTO starter_armor VALUES (?,?,?)", [(k[:-len("_starter_armor")], j, x) for j, x in enumerate(v)])

    for i, (mid, m) in enumerate(db["monsters"].items()):
        check_keys("monster " + mid, m, MONSTER_FIELDS)
        dark = m.get("dark_bonus")
        if dark is not None:
            check_keys("monster %s dark_bonus" % mid, dark, {"aggro_radius", "stats"})
        con.execute("INSERT INTO monsters VALUES (?,?,?,?,?,?,?,?,?)",
                    (mid, i, m["name_ko"], m["grade"], m["floor"], m["zone"], int(m["ranged"]), m.get("ai"),
                     dark["aggro_radius"] if dark else None))
        many("INSERT INTO monster_stats VALUES (?,?,?,?)",
             [(mid, "override", k, v) for k, v in m.get("stat_override", {}).items()]
             + [(mid, "dark", k, v) for k, v in (dark or {}).get("stats", {}).items()])
        many("INSERT INTO monster_skills VALUES (?,?,?)", [(mid, j, x) for j, x in enumerate(m.get("skills", []))])

    md = rest["monster_defaults"]
    check_keys("monster_defaults", md, {"stats", "skills", "ai"})
    many("INSERT INTO monster_default_stats VALUES (?,?)", list(md.pop("stats").items()))
    many("INSERT INTO monster_default_skills VALUES (?,?)", list(enumerate(md.pop("skills"))))
    for i, (nid, n) in enumerate(rest.pop("npcs").items()):
        check_keys("npc " + nid, n, {"name_ko", "humanoid", "ranged", "stats", "skills"})
        con.execute("INSERT INTO npcs VALUES (?,?,?,?,?)", (nid, i, n["name_ko"], int(n["humanoid"]), int(n["ranged"])))
        many("INSERT INTO npc_stats VALUES (?,?,?)", [(nid, k, v) for k, v in n["stats"].items()])
        many("INSERT INTO npc_skills VALUES (?,?,?)", [(nid, j, x) for j, x in enumerate(n["skills"])])

    for key in ("skills", "races", "monsters"):
        del rest[key]
    settings = []
    for key in ORDER:
        if key in rest:
            flatten(key, rest[key], settings)
    many("INSERT INTO settings VALUES (?,?,?)", [(p, i, dumps(v)) for i, (p, v) in enumerate(settings)])
    bad = con.execute("PRAGMA foreign_key_check").fetchall()
    if bad:
        raise ValueError("foreign key violations: %s" % bad[:5])
    con.commit()
    con.close()


def export(path):
    con = sqlite3.connect(path)
    q = lambda sql, *a: con.execute(sql, a).fetchall()  # noqa: E731
    db = {}
    for p, v in q("SELECT path, value FROM settings ORDER BY seq"):
        put(db, p, json.loads(v))
    db["stat_names"] = dict(q("SELECT id, name_ko FROM stats ORDER BY seq"))
    db["zone_names"] = dict(q("SELECT id, name_ko FROM zones ORDER BY seq"))

    db["status_names"] = {}
    status = {}
    for sid, name, *cols in q("SELECT id, name_ko, %s FROM statuses ORDER BY seq" % ", ".join(STATUS_COLS)):
        db["status_names"][sid] = name
        status[sid] = {k: _num(v) for k, v in zip(STATUS_COLS, cols) if v is not None}
        pen = {st: _num(v) for st, v in q("SELECT stat_id, delta FROM status_penalties WHERE status_id=?", sid)}
        if pen:
            status[sid]["stat_penalty"] = pen
    put(db, "rules.status", status)

    db["part_names"] = {}
    parts, effects, gear = [], {}, {}
    for pid, name, stat, delta, slot in q("SELECT id, name_ko, effect_stat, effect_delta, gear_slot FROM parts ORDER BY seq"):
        db["part_names"][pid] = name
        parts.append(pid)
        effects[pid] = {"stat": stat, "delta": _num(delta)}
        if slot is not None:
            gear[pid] = slot
    put(db, "rules.part_damage.parts", parts)
    put(db, "rules.part_damage.effects", effects)
    put(db, "rules.part_damage.gear_slot", gear)

    grades = q("SELECT grade, exchange_rate, exp FROM grades ORDER BY grade DESC")
    put(db, "economy.exchange_rate_by_grade", {str(g): r for g, r, _ in grades})
    put(db, "progression.exp_by_grade", {str(g): e for g, _, e in grades})
    put(db, "progression.exp_to_level", [e for _, e in q("SELECT level, exp FROM level_exp ORDER BY level")])
    for fl, size in q("SELECT floor, size FROM floor_group_sizes ORDER BY floor, day"):
        db["dungeon"]["floor%d" % fl].setdefault("group_by_day", []).append(size)

    skills = {}
    for sid, name, kind, cost, cd, power, rng, sb, sp in q(
            "SELECT id, name_ko, kind, cost, cooldown, power, attack_range, shield_base, shield_per_phys_res"
            " FROM skills ORDER BY seq"):
        s = {"name_ko": name, "kind": kind}
        for k, v in (("power", power), ("range", rng), ("shield_base", sb), ("shield_per_phys_res", sp)):
            if v is not None:
                s[k] = _num(v)
        s["cost"], s["cooldown"] = cost, cd
        effs = []
        for st, chance, stacks, dur in q(
                "SELECT status_id, chance, stacks, duration FROM skill_effects WHERE skill_id=? ORDER BY seq", sid):
            e = {"status": st}
            for k, v in (("chance", chance), ("stacks", stacks), ("duration", dur)):
                if v is not None:
                    e[k] = _num(v)
            effs.append(e)
        if effs:
            s["on_hit"] = effs
        skills[sid] = s
    db["player_default_skills"] = [x for _, x in q("SELECT seq, skill_id FROM player_skills ORDER BY seq")]

    races = {}
    for rid, name, *main in q("SELECT id, name_ko, body, mind, psychic FROM races ORDER BY seq"):
        stats = dict(zip(MAIN_STATS, main))
        stats.update(q("SELECT stat_id, value FROM race_substats WHERE race_id=?", rid))
        races[rid] = {"name_ko": name, "stats": {k: _num(stats.get(k, 0)) for k in RACE_STATS}}

    equipment = {}
    for group in ITEM_GROUPS:
        items = {}
        for iid, name, desc, slot, rng, dur in q(
                "SELECT id, name_ko, desc, slot, attack_range, durability FROM items WHERE category=? ORDER BY seq", group):
            it = {"name_ko": name, "desc": desc}
            if group == "weapons":
                it["range"] = rng
            else:
                it["durability"] = dur
            it["slot"] = slot
            it["bonuses"] = {k: _num(v) for k, v in q("SELECT stat_id, value FROM item_bonuses WHERE item_id=?", iid)}
            items[iid] = it
        equipment[group] = items
    for rid, item in q("SELECT race_id, item_id FROM starter_armor ORDER BY race_id, seq"):
        equipment.setdefault(rid + "_starter_armor", []).append(item)
    db["equipment"] = equipment

    monsters = {}
    for mid, name, grade, floor, zone, ranged, ai, dark_r in q(
            "SELECT id, name_ko, grade, floor, zone, ranged, ai, dark_aggro_radius FROM monsters ORDER BY seq"):
        m = {"name_ko": name, "grade": grade, "floor": floor, "zone": zone, "ranged": bool(ranged)}
        for kind in ("override", "dark"):
            st = {k: _num(v) for k, v in q("SELECT stat_id, value FROM monster_stats WHERE monster_id=? AND kind=?", mid, kind)}
            if kind == "override" and st:
                m["stat_override"] = st
            if kind == "dark" and dark_r is not None:
                m["dark_bonus"] = {"aggro_radius": dark_r, "stats": st}
        sk = [x for x, in q("SELECT skill_id FROM monster_skills WHERE monster_id=? ORDER BY seq", mid)]
        if sk:
            m["skills"] = sk
        if ai is not None:
            m["ai"] = ai
        monsters[mid] = m
    db["monster_defaults"]["stats"] = {k: _num(v) for k, v in q("SELECT stat_id, value FROM monster_default_stats")}
    db["monster_defaults"]["skills"] = [x for _, x in q("SELECT seq, skill_id FROM monster_default_skills ORDER BY seq")]
    npcs = {}
    for nid, name, humanoid, ranged in q("SELECT id, name_ko, humanoid, ranged FROM npcs ORDER BY seq"):
        npcs[nid] = {"name_ko": name, "humanoid": bool(humanoid), "ranged": bool(ranged),
                     "stats": {k: _num(v) for k, v in q("SELECT stat_id, value FROM npc_stats WHERE npc_id=?", nid)},
                     "skills": [x for x, in q("SELECT skill_id FROM npc_skills WHERE npc_id=? ORDER BY seq", nid)]}
    con.close()
    db.update(skills=skills, races=races, monsters=monsters, npcs=npcs)
    return {k: db[k] for k in ORDER}


def _num(x):
    return int(x) if isinstance(x, float) and x.is_integer() else x


def load_json(path=JSON_PATH):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def main(argv):
    cmd = argv[1] if len(argv) > 1 else "check"
    if cmd == "build":
        build(load_json(*argv[2:3]), argv[3] if len(argv) > 3 else DB_PATH)
    elif cmd == "export":
        text = json.dumps(export(argv[2] if len(argv) > 2 else DB_PATH), ensure_ascii=False, indent=2) + "\n"
        if len(argv) > 3:
            open(argv[3], "w", encoding="utf-8").write(text)
        else:
            sys.stdout.write(text)
    elif cmd == "check":
        if export(DB_PATH) != load_json():
            sys.exit("data/dungeon_stone.db 가 db.json 과 다르다: python3 scripts/db_tool.py build")
        print("ok")
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv)
