"""고정 수치 DB(SQLite) 도구: db.json <-> data/dungeon_stone.db.

    python3 scripts/db_tool.py build [json] [db]    # db.json -> SQLite (db 는 덮어씀)
    python3 scripts/db_tool.py export [db] [json]   # SQLite -> JSON (기본 출력은 stdout)
    python3 scripts/db_tool.py check                # 커밋된 .db 가 db.json 과 같은 내용인지 점검

표 구성: skills · races · items(무기·방어구) · monsters 는 개체별 표,
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
ITEM_GROUPS = ("weapons", "armor")

SCHEMA = """
CREATE TABLE settings (path TEXT PRIMARY KEY, seq INTEGER NOT NULL, value TEXT NOT NULL);
CREATE TABLE skills (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, name_ko TEXT NOT NULL, kind TEXT NOT NULL,
    cost INTEGER NOT NULL, cooldown INTEGER NOT NULL, power REAL, extra TEXT NOT NULL);
CREATE TABLE races (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, name_ko TEXT NOT NULL,
    spirit REAL NOT NULL, body REAL NOT NULL, mind REAL NOT NULL, psychic REAL NOT NULL,
    strength REAL NOT NULL, phys_res REAL NOT NULL, regen REAL NOT NULL, smell REAL NOT NULL);
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
        if key in ENTITY_KEYS:
            continue
        if key == "equipment":
            for k, v in db[key].items():
                if k not in ITEM_GROUPS:
                    flatten("equipment." + k, v, settings)
        else:
            flatten(key, db[key], settings)
    con.executemany("INSERT INTO settings VALUES (?,?,?)",
                    [(p, i, dumps(v)) for i, (p, v) in enumerate(settings)])
    for i, (sid, s) in enumerate(db["skills"].items()):
        extra = split(s, ("name_ko", "kind", "cost", "cooldown", "power"))
        con.execute("INSERT INTO skills VALUES (?,?,?,?,?,?,?,?)",
                    (sid, i, s["name_ko"], s["kind"], s["cost"], s["cooldown"], s.get("power"), dumps(extra)))
    for i, (rid, r) in enumerate(db["races"].items()):
        if set(r["stats"]) != set(RACE_STATS) or set(r) != {"name_ko", "stats"}:
            raise ValueError("race %s: unexpected fields" % rid)
        con.execute("INSERT INTO races VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (rid, i, r["name_ko"]) + tuple(r["stats"][k] for k in RACE_STATS))
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
    for row in con.execute("SELECT * FROM races ORDER BY seq"):
        races[row[0]] = {"name_ko": row[2], "stats": {k: _num(v) for k, v in zip(RACE_STATS, row[3:])}}
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
