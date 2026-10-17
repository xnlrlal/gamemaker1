import datetime
import importlib.util
import os
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("check_handoff", os.path.join(ROOT, "scripts", "check_handoff.py"))
ch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ch)

D = datetime.date
GOOD = "# x\n\n## 현재 상태 (2026-10-14)\n- 내용\n\n## 다음에 할 일 (우선순위 제안)\n1. 첫째\n2. 둘째\n\n## 코드 구조\n"


class EvaluateTests(unittest.TestCase):
    def check(self, changed, text=GOOD, newest=D(2026, 10, 14), today=D(2026, 10, 14)):
        return ch.evaluate(set(changed), text, newest, today)

    def test_no_changes_passes(self):
        self.assertEqual(self.check([]), [])

    def test_code_change_without_claude_md_fails(self):
        p = self.check(["web/src/ui.js"])
        self.assertEqual(len(p), 2)
        self.assertIn("web/src/ui.js", p[0])

    def test_code_change_with_claude_md_and_todo_passes(self):
        self.assertEqual(self.check(["web/src/ui.js", "CLAUDE.md", "docs/TODO.md"]), [])

    def test_code_change_without_todo_fails(self):
        p = self.check(["web/src/ui.js", "CLAUDE.md"])
        self.assertEqual(len(p), 1)
        self.assertIn("TODO.md", p[0])

    def test_todo_only_is_exempt(self):
        self.assertEqual(self.check(["docs/TODO.md"]), [])

    def test_docs_and_data_count_as_work(self):
        self.assertTrue(self.check(["docs/design_notes_v7.md"]))
        self.assertTrue(self.check(["data/db.json"]))
        self.assertTrue(self.check(["tests/test_combat.py"]))

    def test_changelog_and_readme_only_are_exempt(self):
        self.assertEqual(self.check(["CHANGELOG.md", "README.md"]), [])

    def test_missing_sections_fail(self):
        p = self.check(["CLAUDE.md"], text="# x\n## 코드 구조\n")
        self.assertTrue(any("현재 상태" in x for x in p))
        self.assertTrue(any("다음에 할 일" in x for x in p))

    def test_next_steps_needs_numbered_items(self):
        text = GOOD.replace("1. 첫째\n2. 둘째\n", "- 번호 없음\n")
        self.assertTrue(any("번호 항목" in x for x in self.check(["CLAUDE.md"], text=text)))

    def test_stale_date_fails(self):
        p = self.check(["CLAUDE.md"], newest=D(2026, 10, 15), today=D(2026, 10, 15))
        self.assertTrue(any("이르다" in x for x in p))

    def test_same_day_is_fine_and_future_date_fails(self):
        self.assertEqual(self.check(["CLAUDE.md"], newest=D(2026, 10, 14)), [])
        p = self.check(["CLAUDE.md"], text=GOOD.replace("2026-10-14", "2027-01-01"))
        self.assertTrue(any("미래" in x for x in p))

    def test_one_day_timezone_slack(self):
        text = GOOD.replace("2026-10-14", "2026-10-15")
        self.assertEqual(self.check(["CLAUDE.md"], text=text, today=D(2026, 10, 14)), [])


class RealFileTests(unittest.TestCase):
    def test_repo_has_todo_backlog(self):
        text = open(os.path.join(ROOT, "docs", "TODO.md"), encoding="utf-8").read()
        for heading in ("## 1. 결정 대기", "## 2. 다음에 할 일", "## 6. 최근 완료"):
            self.assertIn(heading, text)

    def test_repo_claude_md_has_required_structure(self):
        text = open(os.path.join(ROOT, "CLAUDE.md"), encoding="utf-8").read()
        self.assertTrue(ch.DATE_RE.search(text), "현재 상태 제목")
        m = ch.NEXT_RE.search(text)
        self.assertTrue(m and ch.ITEM_RE.search(m.group(1)), "다음에 할 일 번호 항목")


if __name__ == "__main__":
    unittest.main()
