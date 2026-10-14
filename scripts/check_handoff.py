#!/usr/bin/env python3
"""CLAUDE.md(세션 인계 문서)가 작업과 함께 갱신됐는지 검사한다.

규칙
  1. CLAUDE.md·CHANGELOG.md·README.md 외의 파일을 바꿨다면(커밋됐든 아직이든) CLAUDE.md 도 같이 바뀌어야 한다.
  2. CLAUDE.md 에는 "## 현재 상태 (YYYY-MM-DD)" 와 번호가 있는 "## 다음에 할 일" 이 있어야 한다.
  3. 현재 상태의 날짜는 이 브랜치의 가장 최근 커밋(병합 커밋 제외)보다 이르면 안 되고, 미래일 수도 없다.

사용법
  python3 scripts/check_handoff.py                 # 일반 검사, 실패하면 종료 코드 1
  python3 scripts/check_handoff.py --hook          # Claude Code Stop 훅용: 실패하면 종료 코드 2 + stderr(Claude 에게 되돌려 보냄)
  SKIP_HANDOFF=1 ...                               # 의도적으로 건너뛰기(문서만 임시 저장할 때 등)
"""
import argparse
import datetime
import json
import os
import re
import subprocess
import sys

EXEMPT = {"CLAUDE.md", "CHANGELOG.md", "README.md", "TEST.md", ".gitignore"}
DATE_RE = re.compile(r"^## 현재 상태 \((\d{4}-\d{2}-\d{2})\)", re.M)
NEXT_RE = re.compile(r"^## 다음에 할 일[^\n]*\n(.*?)(?=^## |\Z)", re.M | re.S)
ITEM_RE = re.compile(r"^\d+\. ", re.M)


def evaluate(changed, claude_text, newest_commit_date, today):
    """문제 목록(문자열)을 돌려준다. 비어 있으면 통과. 순수 함수라 테스트하기 쉽다."""
    problems = []
    substantive = sorted(f for f in changed if f not in EXEMPT)
    if substantive and "CLAUDE.md" not in changed:
        shown = ", ".join(substantive[:5]) + (" 외 %d개" % (len(substantive) - 5) if len(substantive) > 5 else "")
        problems.append("작업 파일을 바꿨는데(%s) CLAUDE.md 가 갱신되지 않았다. '현재 상태'와 '다음에 할 일'을 고쳐라." % shown)
    if not substantive and "CLAUDE.md" not in changed:
        return problems  # 인계 문서와 무관한 변경(또는 변경 없음)

    m = DATE_RE.search(claude_text)
    if not m:
        problems.append("CLAUDE.md 에 '## 현재 상태 (YYYY-MM-DD)' 제목이 없다.")
    else:
        d = datetime.date.fromisoformat(m.group(1))
        if d > today + datetime.timedelta(days=1):
            problems.append("CLAUDE.md '현재 상태' 날짜(%s)가 미래다." % d)
        if newest_commit_date and d < newest_commit_date:
            problems.append("CLAUDE.md '현재 상태' 날짜(%s)가 최근 커밋 날짜(%s)보다 이르다. 날짜와 내용을 갱신해라." % (d, newest_commit_date))
    n = NEXT_RE.search(claude_text)
    if not n:
        problems.append("CLAUDE.md 에 '## 다음에 할 일' 절이 없다.")
    elif not ITEM_RE.search(n.group(1)):
        problems.append("CLAUDE.md '다음에 할 일'에 번호 항목(1. …)이 하나도 없다. 할 일이 없으면 그렇게 적고, 있으면 채워라.")
    return problems


def git(*args):
    r = subprocess.run(["git", *args], capture_output=True, text=True)
    return r.returncode, r.stdout.strip()


def resolve_base(explicit):
    for ref in ([explicit] if explicit else []) + ["origin/main", "main"]:
        rc, _ = git("rev-parse", "--verify", "--quiet", ref)
        if rc == 0:
            rc, mb = git("merge-base", ref, "HEAD")
            if rc == 0 and mb:
                return mb
    return None


def collect(base):
    changed = set()
    if base:
        rc, out = git("diff", "--name-only", base, "HEAD")
        changed.update(out.splitlines() if rc == 0 else [])
    rc, out = git("status", "--porcelain", "--untracked-files=all")
    for line in out.splitlines() if rc == 0 else []:
        path = line[3:].split(" -> ")[-1].strip().strip('"')
        if path:
            changed.add(path)
    newest = None
    if base:
        rc, out = git("log", "--no-merges", "--format=%cs", base + "..HEAD")
        dates = [datetime.date.fromisoformat(x) for x in out.split() if x] if rc == 0 else []
        newest = max(dates) if dates else None
    dirty = any(not (f in EXEMPT) for f in changed) and git("status", "--porcelain")[1] != ""
    if dirty:  # 아직 커밋하지 않은 변경이 있으면 오늘 작업한 것으로 본다
        newest = max(newest or datetime.date.min, datetime.date.today())
    return changed, newest


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=os.environ.get("HANDOFF_BASE"))
    ap.add_argument("--hook", action="store_true", help="Claude Code Stop 훅 모드")
    args = ap.parse_args()
    if os.environ.get("SKIP_HANDOFF") == "1":
        return 0
    if args.hook:
        try:
            payload = json.loads(sys.stdin.read() or "{}")
        except ValueError:
            payload = {}
        if payload.get("stop_hook_active"):
            return 0  # 한 번 되돌려 보낸 뒤에는 무한 반복하지 않는다
    root = git("rev-parse", "--show-toplevel")[1]
    if not root:
        return 0
    os.chdir(root)
    path = os.path.join(root, "CLAUDE.md")
    claude = open(path, encoding="utf-8").read() if os.path.exists(path) else ""
    changed, newest = collect(resolve_base(args.base))
    problems = evaluate(changed, claude, newest, datetime.date.today())
    if not problems:
        return 0
    msg = "[인계 문서 점검] " + "\n[인계 문서 점검] ".join(problems) + "\n→ CLAUDE.md 의 '현재 상태'와 '다음에 할 일'을 갱신하고 커밋한 뒤 마무리해라. (의도적으로 건너뛰려면 SKIP_HANDOFF=1)"
    print(msg, file=sys.stderr)
    return 2 if args.hook else 1


if __name__ == "__main__":
    sys.exit(main())
