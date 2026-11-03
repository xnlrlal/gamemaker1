import json
import os
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
import db_tool  # noqa: E402


class DbToolTest(unittest.TestCase):
    def test_round_trip_matches_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "t.db")
            db_tool.build(db_tool.load_json(), path)
            self.assertEqual(db_tool.export(path), db_tool.load_json())

    def test_committed_db_is_fresh(self):
        self.assertEqual(db_tool.export(db_tool.DB_PATH), db_tool.load_json())

    def test_tables_are_queryable(self):
        con = sqlite3.connect(db_tool.DB_PATH)
        grade, = con.execute("SELECT grade FROM monsters WHERE id='goblin'").fetchone()
        base, = con.execute("SELECT value FROM settings WHERE path='rules.hit.base'").fetchone()
        con.close()
        self.assertEqual(grade, db_tool.load_json()["monsters"]["goblin"]["grade"])
        self.assertEqual(json.loads(base), db_tool.load_json()["rules"]["hit"]["base"])

    def test_race_stats_are_rows_and_main_stats_are_marked_by_group(self):
        con = sqlite3.connect(db_tool.DB_PATH)
        stats = dict(con.execute("SELECT stat_id, value FROM race_stats WHERE race_id='barbarian'"))
        main = {r[0] for r in con.execute("SELECT id FROM stats WHERE grp='main'")}
        con.close()
        self.assertEqual((stats["body"], stats["mind"], stats["psychic"], stats["strength"]), (25, 35, 1, 3))
        self.assertEqual(main, {"body", "mind", "psychic"})

    def test_unknown_fields_are_kept_without_schema_changes(self):
        db = db_tool.load_json()
        db["stat_names"]["sight"] = "시각"
        db["stat_groups"]["sight"] = "body"
        db["races"]["human"]["stats"]["sight"] = 2
        db["races"]["human"]["lore"] = {"origin": "평원"}
        db["skills"]["slash"]["element"] = "none"
        db["skills"]["slash"]["tags"] = ["melee", "basic"]
        db["skills"]["pierce"]["on_hit"][0]["note"] = "x"
        db["rules"]["status"]["bleed"]["heal_block"] = True
        db["rules"]["status"]["poison"]["stat_penalty"] = {"sight": -1}
        db["monsters"]["goblin"]["night_bonus"] = {"aggro_radius": 2, "stats": {"accuracy": 3}}
        db["monsters"]["goblin"]["loot"] = ["tooth", "ear"]
        db["equipment"]["armor"]["sandals"]["weight"] = 1.5
        db["equipment"]["barbarian_charm"] = ["lucky"]
        db["npcs"]["wanderer"]["greeting"] = "안녕"
        db["new_section"] = {"a": {"b": [1, 2]}, "c": 3}
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "t.db")
            db_tool.build(db, path)
            out = db_tool.export(path)
        self.assertEqual(out, db)
        self.assertEqual(json.dumps(out, sort_keys=True), json.dumps(db, sort_keys=True))

    def test_foreign_keys_hold_and_children_are_rows(self):
        con = sqlite3.connect(db_tool.DB_PATH)
        bad = con.execute("PRAGMA foreign_key_check").fetchall()
        skills = [r[0] for r in con.execute("SELECT skill_id FROM monster_skills WHERE monster_id='goblin' ORDER BY seq")]
        override = dict(con.execute("SELECT stat_id, value FROM monster_stats WHERE monster_id='goblin' AND kind='override'"))
        con.close()
        self.assertEqual(bad, [])
        self.assertEqual(skills, ["poison_stab", "slash"])
        self.assertEqual(override, {"strength": -8, "accuracy": -10})


if __name__ == "__main__":
    unittest.main()
