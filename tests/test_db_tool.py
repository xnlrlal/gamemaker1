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


if __name__ == "__main__":
    unittest.main()
