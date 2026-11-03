"""고정 수치 DB(SQLite) 도구: db.json <-> data/dungeon_stone.db.

    python3 scripts/db_tool.py build [json] [db]    # db.json -> SQLite (db 는 덮어씀)
    python3 scripts/db_tool.py export [db] [json]   # SQLite -> JSON (기본 출력은 stdout)
    python3 scripts/db_tool.py check                # 커밋된 .db 가 db.json 과 같은 내용인지 점검

설계 원칙: 정규화하되 **아직 확정되지 않은 것을 담을 자리를 열어 둔다.**
  - 개체(스킬·상태이상·부위·종족·장비·몬스터·NPC)는 식별/이름 같은 뼈대 열만 갖고, 나머지 필드는
    <개체>_params(키, 값) 표에 한 줄씩 들어간다. 새 필드는 표 구조·이 파일을 고치지 않고 db.json 에 쓰면 된다
    (숫자·문자는 값 칸에, 목록·객체·불·null 은 is_json=1 로 JSON 문자열).
  - 스탯은 stats 표가 정의한다(새 스탯 = 한 줄 추가). 종족·장비·몬스터·NPC 의 스탯은 (소유자, stat_id, 값) 행이라
    스탯이 늘어도 열이 늘지 않는다. 메인스탯 여부는 stats.grp 로 구분한다(db.json 의 stat_groups).
  - 알려진 모양(스킬 효과 목록, 상태이상 페널티, 부위, 등급, 레벨, 층별 무리 크기, 몬스터 문맥별 보너스 등)만
    자식 표로 빼고, 모르는 구조는 버리거나 막지 않고 settings(점 경로)나 *_params 로 보존한다.
  - db.json 최상위에 새 구역(섹션)을 만들어도 settings 로 들어가고 되돌려진다.
db.json 에서 DB 로 갔다가 되돌려도 내용이 같다(키 순서는 ORDER 기준, 새 최상위 키는 뒤에).
"""
import copy
import json
import os
import sqlite3
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JSON_PATH = os.path.join(ROOT, "data", "db.json")
DB_PATH = os.path.join(ROOT, "data", "dungeon_stone.db")

ORDER = ["meta", "status_names", "part_names", "stat_names", "stat_groups", "zone_names", "dungeon", "economy",
         "progression", "rules", "player_default_skills", "skills", "races", "equipment", "monsters",
         "monster_defaults", "npcs"]
ITEM_GROUPS = ("weapons", "armor")
DEFAULT_STAT_GROUP = "etc"
CONTEXT_SUFFIX = "_bonus"  # 몬스터의 "<문맥>_bonus": {stats:{…}, 기타 값…} 은 문맥별 보너스로 본다(예: dark_bonus)

PARAM_TABLES = {  # 표 이름: 소유자 열
    "skill_params": "skill_id", "status_params": "status_id", "part_params": "part_id", "race_params": "race_id",
    "item_params": "item_id", "monster_params": "monster_id", "npc_params": "npc_id",
}

SCHEMA = """
CREATE TABLE settings (path TEXT PRIMARY KEY, seq INTEGER NOT NULL, value TEXT NOT NULL);
CREATE TABLE stats (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, name_ko TEXT NOT NULL, grp TEXT NOT NULL);
CREATE TABLE zones (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, name_ko TEXT NOT NULL);
CREATE TABLE statuses (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, name_ko TEXT NOT NULL);
CREATE TABLE status_penalties (status_id TEXT NOT NULL REFERENCES statuses(id),
    stat_id TEXT NOT NULL REFERENCES stats(id), delta NOT NULL, PRIMARY KEY (status_id, stat_id));
CREATE TABLE parts (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, name_ko TEXT NOT NULL,
    effect_stat TEXT NOT NULL REFERENCES stats(id), effect_delta NOT NULL, gear_slot TEXT);
CREATE TABLE grades (grade INTEGER PRIMARY KEY, exchange_rate NOT NULL, exp NOT NULL);
CREATE TABLE level_exp (level INTEGER PRIMARY KEY, exp NOT NULL);
CREATE TABLE floor_group_sizes (floor INTEGER NOT NULL, day INTEGER NOT NULL, size INTEGER NOT NULL,
    PRIMARY KEY (floor, day));
CREATE TABLE skills (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, name_ko TEXT NOT NULL, kind TEXT NOT NULL,
    cost NOT NULL, cooldown NOT NULL, power);
CREATE TABLE skill_effects (skill_id TEXT NOT NULL REFERENCES skills(id), seq INTEGER NOT NULL,
    status_id TEXT NOT NULL REFERENCES statuses(id), PRIMARY KEY (skill_id, seq));
CREATE TABLE skill_effect_params (skill_id TEXT NOT NULL, seq INTEGER NOT NULL, key TEXT NOT NULL,
    value NOT NULL, is_json INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (skill_id, seq, key),
    FOREIGN KEY (skill_id, seq) REFERENCES skill_effects(skill_id, seq));
CREATE TABLE player_skills (seq INTEGER PRIMARY KEY, skill_id TEXT NOT NULL REFERENCES skills(id));
CREATE TABLE races (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, name_ko TEXT NOT NULL);
CREATE TABLE race_stats (race_id TEXT NOT NULL REFERENCES races(id), stat_id TEXT NOT NULL REFERENCES stats(id),
    value NOT NULL, PRIMARY KEY (race_id, stat_id));
CREATE TABLE items (id TEXT PRIMARY KEY, category TEXT NOT NULL, seq INTEGER NOT NULL, name_ko TEXT NOT NULL,
    desc TEXT NOT NULL, slot TEXT NOT NULL);
CREATE TABLE item_bonuses (item_id TEXT NOT NULL REFERENCES items(id), stat_id TEXT NOT NULL REFERENCES stats(id),
    value NOT NULL, PRIMARY KEY (item_id, stat_id));
CREATE TABLE starter_armor (race_id TEXT NOT NULL REFERENCES races(id), seq INTEGER NOT NULL,
    item_id TEXT NOT NULL REFERENCES items(id), PRIMARY KEY (race_id, seq));
CREATE TABLE monsters (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, name_ko TEXT NOT NULL,
    grade INTEGER NOT NULL REFERENCES grades(grade), floor INTEGER NOT NULL,
    zone TEXT NOT NULL REFERENCES zones(id), ranged INTEGER NOT NULL);
CREATE TABLE monster_stats (monster_id TEXT NOT NULL REFERENCES monsters(id), kind TEXT NOT NULL,
    stat_id TEXT NOT NULL REFERENCES stats(id), value NOT NULL, PRIMARY KEY (monster_id, kind, stat_id));
CREATE TABLE monster_context_params (monster_id TEXT NOT NULL REFERENCES monsters(id), kind TEXT NOT NULL,
    key TEXT NOT NULL, value NOT NULL, is_json INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (monster_id, kind, key));
CREATE TABLE monster_skills (monster_id TEXT NOT NULL REFERENCES monsters(id), seq INTEGER NOT NULL,
    skill_id TEXT NOT NULL REFERENCES skills(id), PRIMARY KEY (monster_id, seq));
CREATE TABLE monster_default_stats (stat_id TEXT PRIMARY KEY REFERENCES stats(id), value NOT NULL);
CREATE TABLE monster_default_skills (seq INTEGER PRIMARY KEY, skill_id TEXT NOT NULL REFERENCES skills(id));
CREATE TABLE npcs (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, name_ko TEXT NOT NULL, humanoid INTEGER NOT NULL,
    ranged INTEGER NOT NULL);
CREATE TABLE npc_stats (npc_id TEXT NOT NULL REFERENCES npcs(id), stat_id TEXT NOT NULL REFERENCES stats(id),
    value NOT NULL, PRIMARY KEY (npc_id, stat_id));
CREATE TABLE npc_skills (npc_id TEXT NOT NULL REFERENCES npcs(id), seq INTEGER NOT NULL,
    skill_id TEXT NOT NULL REFERENCES skills(id), PRIMARY KEY (npc_id, seq));
""" + "".join(
    "CREATE TABLE %s (%s TEXT NOT NULL, key TEXT NOT NULL, value NOT NULL, is_json INTEGER NOT NULL DEFAULT 0,"
    " PRIMARY KEY (%s, key));\n" % (t, o, o) for t, o in PARAM_TABLES.items())


def dumps(v):
    return json.dumps(v, ensure_ascii=False)


def is_scalar(v):
    return type(v) in (int, float, str)


def is_num_map(v):
    return isinstance(v, dict) and bool(v) and all(type(x) in (int, float) for x in v.values())


def encode(v):
    """(저장값, is_json). 숫자·문자는 그대로, 나머지(목록·객체·불·null)는 JSON 문자열."""
    return (v, 0) if is_scalar(v) else (dumps(v), 1)


def decode(v, is_json):
    return json.loads(v) if is_json else _num(v)


def flatten(prefix, value, out):
    if isinstance(value, dict) and value:
        for k, v in value.items():
            if "." in k:
                raise ValueError("key with '.' is not allowed: %s.%s" % (prefix, k))
            flatten(prefix + "." + k, v, out)
    else:
        out.append((prefix, value))


def pop(node, path, default=None):
    """점 경로(a.b.c)의 값을 떼어 돌려준다(없으면 default)."""
    keys = path.split(".")
    for k in keys[:-1]:
        if not isinstance(node, dict) or k not in node:
            return default
        node = node[k]
    return node.pop(keys[-1], default) if isinstance(node, dict) else default


def put(node, path, value):
    keys = path.split(".")
    for k in keys[:-1]:
        node = node.setdefault(k, {})
    node[keys[-1]] = value


def save_params(con, table, owner, obj, skip=()):
    """obj 에서 skip 을 뺀 모든 필드를 <개체>_params 에 한 줄씩 넣는다."""
    for k, v in obj.items():
        if k not in skip:
            con.execute("INSERT INTO %s VALUES (?,?,?,?)" % table, (owner, k) + encode(v))


def load_params(con, table, owner):
    owner_col = PARAM_TABLES[table]
    return {k: decode(v, j) for k, v, j in con.execute(
        "SELECT key, value, is_json FROM %s WHERE %s=? ORDER BY rowid" % (table, owner_col), (owner,))}


def build(db, path):
    if os.path.exists(path):
        os.remove(path)
    rest = copy.deepcopy(db)
    con = sqlite3.connect(path)
    con.executescript(SCHEMA)
    con.execute("PRAGMA foreign_keys=ON")
    many = con.executemany

    groups = pop(rest, "stat_groups", {})
    for i, (stat, name) in enumerate(pop(rest, "stat_names").items()):
        con.execute("INSERT INTO stats VALUES (?,?,?,?)", (stat, i, name, groups.get(stat, DEFAULT_STAT_GROUP)))
    many("INSERT INTO zones VALUES (?,?,?)", [(z, i, n) for i, (z, n) in enumerate(pop(rest, "zone_names").items())])

    status_rules = pop(rest, "rules.status")
    status_names = pop(rest, "status_names")
    if set(status_rules) != set(status_names):
        raise ValueError("status_names and rules.status differ")
    for i, (sid, name) in enumerate(status_names.items()):
        r = dict(status_rules[sid])
        con.execute("INSERT INTO statuses VALUES (?,?,?)", (sid, i, name))
        if is_num_map(r.get("stat_penalty")):
            many("INSERT INTO status_penalties VALUES (?,?,?)", [(sid, k, v) for k, v in r.pop("stat_penalty").items()])
        save_params(con, "status_params", sid, r)

    part_names = pop(rest, "part_names")
    parts, effects, gear = (pop(rest, "rules.part_damage." + k) for k in ("parts", "effects", "gear_slot"))
    if not (list(part_names) == parts == list(effects)) or set(gear) - set(parts):
        raise ValueError("part_names, part_damage.parts/effects/gear_slot differ")
    for i, pid in enumerate(parts):
        ef = effects[pid]
        con.execute("INSERT INTO parts VALUES (?,?,?,?,?,?)",
                    (pid, i, part_names[pid], ef["stat"], ef["delta"], gear.get(pid)))
        save_params(con, "part_params", pid, {"effect." + k: v for k, v in ef.items() if k not in ("stat", "delta")})

    rates = pop(rest, "economy.exchange_rate_by_grade")
    exps = pop(rest, "progression.exp_by_grade")
    if set(rates) != set(exps):
        raise ValueError("exchange_rate_by_grade and exp_by_grade differ")
    many("INSERT INTO grades VALUES (?,?,?)", [(int(g), rates[g], exps[g]) for g in rates])
    many("INSERT INTO level_exp VALUES (?,?)", list(enumerate(pop(rest, "progression.exp_to_level"))))
    for fk, fl in rest["dungeon"].items():
        if fk.startswith("floor") and isinstance(fl, dict) and "group_by_day" in fl:
            many("INSERT INTO floor_group_sizes VALUES (?,?,?)",
                 [(int(fk[5:]), day + 1, n) for day, n in enumerate(fl.pop("group_by_day"))])

    for i, (sid, sk) in enumerate(db["skills"].items()):
        con.execute("INSERT INTO skills VALUES (?,?,?,?,?,?,?)",
                    (sid, i, sk["name_ko"], sk["kind"], sk["cost"], sk["cooldown"], sk.get("power")))
        for j, ef in enumerate(sk.get("on_hit", [])):
            con.execute("INSERT INTO skill_effects VALUES (?,?,?)", (sid, j, ef["status"]))
            for k, v in ef.items():
                if k != "status":
                    con.execute("INSERT INTO skill_effect_params VALUES (?,?,?,?,?)", (sid, j, k) + encode(v))
        save_params(con, "skill_params", sid, sk, skip=("name_ko", "kind", "cost", "cooldown", "power", "on_hit"))
    many("INSERT INTO player_skills VALUES (?,?)", list(enumerate(pop(rest, "player_default_skills"))))

    for i, (rid, r) in enumerate(db["races"].items()):
        con.execute("INSERT INTO races VALUES (?,?,?)", (rid, i, r["name_ko"]))
        many("INSERT INTO race_stats VALUES (?,?,?)", [(rid, k, v) for k, v in r["stats"].items()])
        save_params(con, "race_params", rid, r, skip=("name_ko", "stats"))

    for group in ITEM_GROUPS:
        for i, (iid, it) in enumerate(db["equipment"][group].items()):
            con.execute("INSERT INTO items VALUES (?,?,?,?,?,?)", (iid, group, i, it["name_ko"], it["desc"], it["slot"]))
            many("INSERT INTO item_bonuses VALUES (?,?,?)", [(iid, k, v) for k, v in it["bonuses"].items()])
            save_params(con, "item_params", iid, it, skip=("name_ko", "desc", "slot", "bonuses"))
    equipment = rest.pop("equipment")
    for k in ITEM_GROUPS:
        equipment.pop(k)
    for k in list(equipment):
        if k.endswith("_starter_armor") and isinstance(equipment[k], list):
            many("INSERT INTO starter_armor VALUES (?,?,?)",
                 [(k[:-len("_starter_armor")], j, x) for j, x in enumerate(equipment.pop(k))])
    if equipment:  # 아직 모르는 장비 설정은 settings 로 보존
        rest["equipment"] = equipment

    for i, (mid, m) in enumerate(db["monsters"].items()):
        con.execute("INSERT INTO monsters VALUES (?,?,?,?,?,?,?)",
                    (mid, i, m["name_ko"], m["grade"], m["floor"], m["zone"], int(m["ranged"])))
        many("INSERT INTO monster_skills VALUES (?,?,?)", [(mid, j, x) for j, x in enumerate(m.get("skills", []))])
        skip = ["name_ko", "grade", "floor", "zone", "ranged", "skills"]
        if is_num_map(m.get("stat_override")):
            many("INSERT INTO monster_stats VALUES (?,?,?,?)", [(mid, "override", k, v) for k, v in m["stat_override"].items()])
            skip.append("stat_override")
        for k, v in m.items():
            if k.endswith(CONTEXT_SUFFIX) and isinstance(v, dict) and is_num_map(v.get("stats")):
                kind = k[:-len(CONTEXT_SUFFIX)]
                many("INSERT INTO monster_stats VALUES (?,?,?,?)", [(mid, kind, s, x) for s, x in v["stats"].items()])
                for pk, pv in v.items():
                    if pk != "stats":
                        con.execute("INSERT INTO monster_context_params VALUES (?,?,?,?,?)", (mid, kind, pk) + encode(pv))
                skip.append(k)
        save_params(con, "monster_params", mid, m, skip=skip)

    md = rest["monster_defaults"]
    many("INSERT INTO monster_default_stats VALUES (?,?)", list(md.pop("stats").items()))
    many("INSERT INTO monster_default_skills VALUES (?,?)", list(enumerate(md.pop("skills"))))
    for i, (nid, n) in enumerate(rest.pop("npcs").items()):
        con.execute("INSERT INTO npcs VALUES (?,?,?,?,?)", (nid, i, n["name_ko"], int(n["humanoid"]), int(n["ranged"])))
        many("INSERT INTO npc_stats VALUES (?,?,?)", [(nid, k, v) for k, v in n["stats"].items()])
        many("INSERT INTO npc_skills VALUES (?,?,?)", [(nid, j, x) for j, x in enumerate(n["skills"])])
        save_params(con, "npc_params", nid, n, skip=("name_ko", "humanoid", "ranged", "stats", "skills"))

    for key in ("skills", "races", "monsters"):
        del rest[key]
    settings = []
    for key in ORDER + [k for k in rest if k not in ORDER]:
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
    stats = q("SELECT id, name_ko, grp FROM stats ORDER BY seq")
    db["stat_names"] = {i: n for i, n, _ in stats}
    db["stat_groups"] = {i: g for i, _, g in stats}
    db["zone_names"] = dict(q("SELECT id, name_ko FROM zones ORDER BY seq"))

    db["status_names"] = {}
    status = {}
    for sid, name in q("SELECT id, name_ko FROM statuses ORDER BY seq"):
        db["status_names"][sid] = name
        status[sid] = load_params(con, "status_params", sid)
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
        effects[pid].update({k[len("effect."):]: v for k, v in load_params(con, "part_params", pid).items()})
        if slot is not None:
            gear[pid] = slot
    put(db, "rules.part_damage.parts", parts)
    put(db, "rules.part_damage.effects", effects)
    put(db, "rules.part_damage.gear_slot", gear)

    grades = q("SELECT grade, exchange_rate, exp FROM grades ORDER BY grade DESC")
    put(db, "economy.exchange_rate_by_grade", {str(g): _num(r) for g, r, _ in grades})
    put(db, "progression.exp_by_grade", {str(g): _num(e) for g, _, e in grades})
    put(db, "progression.exp_to_level", [_num(e) for _, e in q("SELECT level, exp FROM level_exp ORDER BY level")])
    for fl, size in q("SELECT floor, size FROM floor_group_sizes ORDER BY floor, day"):
        db["dungeon"]["floor%d" % fl].setdefault("group_by_day", []).append(size)

    skills = {}
    for sid, name, kind, cost, cd, power in q("SELECT id, name_ko, kind, cost, cooldown, power FROM skills ORDER BY seq"):
        s = {"name_ko": name, "kind": kind}
        if power is not None:
            s["power"] = _num(power)
        s["cost"], s["cooldown"] = _num(cost), _num(cd)
        s.update(load_params(con, "skill_params", sid))
        effs = []
        for j, st in q("SELECT seq, status_id FROM skill_effects WHERE skill_id=? ORDER BY seq", sid):
            e = {"status": st}
            e.update({k: decode(v, js) for k, v, js in q(
                "SELECT key, value, is_json FROM skill_effect_params WHERE skill_id=? AND seq=? ORDER BY rowid", sid, j)})
            effs.append(e)
        if effs:
            s["on_hit"] = effs
        skills[sid] = s
    db["player_default_skills"] = [x for _, x in q("SELECT seq, skill_id FROM player_skills ORDER BY seq")]

    races = {}
    for rid, name in q("SELECT id, name_ko FROM races ORDER BY seq"):
        races[rid] = {"name_ko": name, "stats": {k: _num(v) for k, v in q(
            "SELECT s.id, r.value FROM race_stats r JOIN stats s ON s.id=r.stat_id WHERE r.race_id=? ORDER BY s.seq", rid)}}
        races[rid].update(load_params(con, "race_params", rid))

    equipment = db.setdefault("equipment", {})
    for group in ITEM_GROUPS:
        items = {}
        for iid, name, desc, slot in q("SELECT id, name_ko, desc, slot FROM items WHERE category=? ORDER BY seq", group):
            it = {"name_ko": name, "desc": desc}
            it.update(load_params(con, "item_params", iid))
            it["slot"] = slot
            it["bonuses"] = {k: _num(v) for k, v in q("SELECT stat_id, value FROM item_bonuses WHERE item_id=?", iid)}
            items[iid] = it
        equipment[group] = items
    for rid, item in q("SELECT race_id, item_id FROM starter_armor ORDER BY race_id, seq"):
        equipment.setdefault(rid + "_starter_armor", []).append(item)

    monsters = {}
    for mid, name, grade, floor, zone, ranged in q("SELECT id, name_ko, grade, floor, zone, ranged FROM monsters ORDER BY seq"):
        m = {"name_ko": name, "grade": grade, "floor": floor, "zone": zone, "ranged": bool(ranged)}
        ctx = {}
        for kind, stat, v in q("SELECT kind, stat_id, value FROM monster_stats WHERE monster_id=? ORDER BY rowid", mid):
            ctx.setdefault(kind, {})[stat] = _num(v)
        if "override" in ctx:
            m["stat_override"] = ctx.pop("override")
        for kind, st in ctx.items():
            b = {k: decode(v, js) for k, v, js in q(
                "SELECT key, value, is_json FROM monster_context_params WHERE monster_id=? AND kind=? ORDER BY rowid", mid, kind)}
            b["stats"] = st
            m[kind + CONTEXT_SUFFIX] = b
        sk = [x for x, in q("SELECT skill_id FROM monster_skills WHERE monster_id=? ORDER BY seq", mid)]
        if sk:
            m["skills"] = sk
        m.update(load_params(con, "monster_params", mid))
        monsters[mid] = m
    db["monster_defaults"]["stats"] = {k: _num(v) for k, v in q("SELECT stat_id, value FROM monster_default_stats")}
    db["monster_defaults"]["skills"] = [x for _, x in q("SELECT seq, skill_id FROM monster_default_skills ORDER BY seq")]
    npcs = {}
    for nid, name, humanoid, ranged in q("SELECT id, name_ko, humanoid, ranged FROM npcs ORDER BY seq"):
        npcs[nid] = {"name_ko": name, "humanoid": bool(humanoid), "ranged": bool(ranged),
                     "stats": {k: _num(v) for k, v in q("SELECT stat_id, value FROM npc_stats WHERE npc_id=?", nid)},
                     "skills": [x for x, in q("SELECT skill_id FROM npc_skills WHERE npc_id=? ORDER BY seq", nid)]}
        npcs[nid].update(load_params(con, "npc_params", nid))
    con.close()
    db.update(skills=skills, races=races, monsters=monsters, npcs=npcs)
    return {k: db[k] for k in ORDER + [k for k in db if k not in ORDER] if k in db}


def _num(x):
    return x  # 값 열에는 타입을 붙이지 않아 SQLite 가 정수/실수를 입력 그대로 돌려준다


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
