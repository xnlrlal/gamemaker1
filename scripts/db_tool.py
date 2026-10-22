"""고정 수치 DB(SQLite) 도구: db.json <-> data/dungeon_stone.db.

    python3 scripts/db_tool.py build [json] [db]    # db.json -> SQLite (db 는 덮어씀)
    python3 scripts/db_tool.py export [db] [json]   # SQLite -> JSON (기본 출력은 stdout)
    python3 scripts/db_tool.py check                # 커밋된 .db 가 db.json 과 같은 내용인지 점검

표 구성: skills · races · items(무기·방어구) · monsters 는 개체별 표,
stats(스탯 정의·분류) · race_substats(종족별 세부스탯, 0 이 아닌 값만),
나머지(rules·dungeon·economy·progression·표시 이름 등)는 settings(path, value) 에
'rules.hit.base' 같은 점 경로로 한 칸씩 저장한다. 리스트·빈 객체는 JSON 한 칸이다.
db.json 에서 DB 로 갔다가 되돌려도 내용이 같다(키 순서는 ORDER 기준).
"""
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
ENTITY_KEYS = ("skills", "races", "monsters")
RACE_STATS = ("spirit", "body", "mind", "psychic", "strength", "phys_res", "regen", "smell")
MAIN_STATS = ("body", "mind", "psychic")
# 스탯 분류(기획서 5-2): main = 메인스탯, 나머지는 세부스탯이 속한 메인스탯
STAT_GROUPS = {"body": "main", "mind": "main", "psychic": "main",
               "strength": "body", "phys_res": "body", "regen": "body", "smell": "body",
               "accuracy": "body", "flexibility": "body", "agility": "body", "spirit": "psychic"}
ITEM_GROUPS = ("weapons", "armor")

SCHEMA = """
CREATE TABLE settings (path TEXT PRIMARY KEY, seq INTEGER NOT NULL, value TEXT NOT NULL);
CREATE TABLE skills (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, name_ko TEXT NOT NULL, kind TEXT NOT NULL,
    cost INTEGER NOT NULL, cooldown INTEGER NOT NULL, power REAL, extra TEXT NOT NULL);
CREATE TABLE stats (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, name_ko TEXT NOT NULL, grp TEXT NOT NULL);
CREATE TABLE races (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, name_ko TEXT NOT NULL,
    body REAL NOT NULL, mind REAL NOT NULL, psychic REAL NOT NULL);
CREATE TABLE race_substats (race_id TEXT NOT NULL REFERENCES races(id), stat_id TEXT NOT NULL REFERENCES stats(id),
    value REAL NOT NULL, PRIMARY KEY (race_id, stat_id));
CREATE TABLE items (id TEXT PRIMARY KEY, category TEXT NOT NULL, seq INTEGER NOT NULL, name_ko TEXT NOT NULL,
    desc TEXT NOT NULL, slot TEXT NOT NULL, bonuses TEXT NOT NULL, extra TEXT NOT NULL);
CREATE TABLE monsters (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, name_ko TEXT NOT NULL, grade INTEGER NOT NULL,
    floor INTEGER NOT NULL, zone TEXT NOT NULL, ranged INTEGER NOT NULL, extra TEXT NOT NULL);
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


def split(d, keys):
    """d 에서 keys 를 뺀 나머지(extra)와 keys 의 값을 돌려준다."""
    return {k: v for k, v in d.items() if k not in keys}


def build(db, path):
    if os.path.exists(path):
        os.remove(path)
    con = sqlite3.connect(path)
    con.executescript(SCHEMA)
    settings = []
    for key in ORDER:
        if key in ENTITY_KEYS or key == "stat_names":
            continue
        if key == "equipment":
            for k, v in db[key].items():
                if k not in ITEM_GROUPS:
                    flatten("equipment." + k, v, settings)
        else:
            flatten(key, db[key], settings)
    con.executemany("INSERT INTO settings VALUES (?,?,?)",
                    [(p, i, dumps(v)) for i, (p, v) in enumerate(settings)])
    for i, (stat, name) in enumerate(db["stat_names"].items()):
        if stat not in STAT_GROUPS:
            raise ValueError("stat %s: no group in STAT_GROUPS" % stat)
        con.execute("INSERT INTO stats VALUES (?,?,?,?)", (stat, i, name, STAT_GROUPS[stat]))
    for i, (sid, s) in enumerate(db["skills"].items()):
        extra = split(s, ("name_ko", "kind", "cost", "cooldown", "power"))
        con.execute("INSERT INTO skills VALUES (?,?,?,?,?,?,?,?)",
                    (sid, i, s["name_ko"], s["kind"], s["cost"], s["cooldown"], s.get("power"), dumps(extra)))
    for i, (rid, r) in enumerate(db["races"].items()):
        if set(r["stats"]) != set(RACE_STATS) or set(r) != {"name_ko", "stats"}:
            raise ValueError("race %s: unexpected fields" % rid)
        con.execute("INSERT INTO races VALUES (?,?,?,?,?,?)",
                    (rid, i, r["name_ko"]) + tuple(r["stats"][k] for k in MAIN_STATS))
        con.executemany("INSERT INTO race_substats VALUES (?,?,?)",
                        [(rid, k, r["stats"][k]) for k in RACE_STATS if k not in MAIN_STATS and r["stats"][k]])
    for group in ITEM_GROUPS:
        for i, (iid, it) in enumerate(db["equipment"][group].items()):
            extra = split(it, ("name_ko", "desc", "slot", "bonuses"))
            con.execute("INSERT INTO items VALUES (?,?,?,?,?,?,?,?)",
                        (iid, group, i, it["name_ko"], it["desc"], it["slot"], dumps(it["bonuses"]), dumps(extra)))
    for i, (mid, m) in enumerate(db["monsters"].items()):
        extra = split(m, ("name_ko", "grade", "floor", "zone", "ranged"))
        con.execute("INSERT INTO monsters VALUES (?,?,?,?,?,?,?,?)",
                    (mid, i, m["name_ko"], m["grade"], m["floor"], m["zone"], int(m["ranged"]), dumps(extra)))
    con.commit()
    con.close()


def export(path):
    con = sqlite3.connect(path)
    db = {}
    for p, v in con.execute("SELECT path, value FROM settings ORDER BY seq"):
        keys = p.split(".")
        node = db
        for k in keys[:-1]:
            node = node.setdefault(k, {})
        node[keys[-1]] = json.loads(v)
    db.setdefault("equipment", {})
    db["stat_names"] = {sid: name for sid, name in con.execute("SELECT id, name_ko FROM stats ORDER BY seq")}
    skills = {}
    for sid, name, kind, cost, cd, power, extra in con.execute(
            "SELECT id, name_ko, kind, cost, cooldown, power, extra FROM skills ORDER BY seq"):
        s = {"name_ko": name, "kind": kind}
        if power is not None:
            s["power"] = _num(power)
        s["cost"], s["cooldown"] = cost, cd
        s.update(json.loads(extra))
        skills[sid] = s
    races = {}
    for rid, name, *main in con.execute("SELECT id, name_ko, body, mind, psychic FROM races ORDER BY seq"):
        stats = dict(zip(MAIN_STATS, main))
        stats.update(con.execute("SELECT stat_id, value FROM race_substats WHERE race_id=?", (rid,)).fetchall())
        races[rid] = {"name_ko": name, "stats": {k: _num(stats.get(k, 0)) for k in RACE_STATS}}
    for group in ITEM_GROUPS:
        items = {}
        for iid, name, desc, slot, bonuses, extra in con.execute(
                "SELECT id, name_ko, desc, slot, bonuses, extra FROM items WHERE category=? ORDER BY seq", (group,)):
            it = {"name_ko": name, "desc": desc}
            it.update(json.loads(extra))
            it.update({"slot": slot, "bonuses": json.loads(bonuses)})
            items[iid] = it
        db["equipment"][group] = items
    monsters = {}
    for mid, name, grade, floor, zone, ranged, extra in con.execute(
            "SELECT id, name_ko, grade, floor, zone, ranged, extra FROM monsters ORDER BY seq"):
        m = {"name_ko": name, "grade": grade, "floor": floor, "zone": zone, "ranged": bool(ranged)}
        m.update(json.loads(extra))
        monsters[mid] = m
    con.close()
    db.update(skills=skills, races=races, monsters=monsters)
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
