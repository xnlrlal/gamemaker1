# 던전 앤 스톤 (gamemaker1)

GameMaker(GML)로 만드는 영구사망 서바이벌 RPG. 기획서는 [`docs/design_notes_v6.md`](docs/design_notes_v6.md).

## 구조

| 경로 | 내용 |
|---|---|
| `data/db.json` | 모든 고정값(규칙 수치·스킬·종족·장비·몬스터). 코드에 숫자를 하드코딩하지 않는다 |
| `sim/` | 전투 코어의 Python 참조 구현 + 밸런스 시뮬레이터. 나중에 GML script 로 이식할 규칙의 기준 |
| `tests/` | 전투 규칙 단위 테스트 (`python3 -m unittest discover -s tests -t .`) |
| `web/` | 브라우저 플레이 프로토타입(모바일 세로 화면). `web/src` 가 로직·UI, `web/build.py` 가 한 파일로 묶는다 |
| `docs/implementation_notes.md` | 구현하며 정한 임시 규칙, 시뮬레이션 결과, 다음 할 일 |
| `docs/WORKFLOW.md` | 브랜치·커밋·병합 규칙(앞으로의 작업 방식) |
| `CHANGELOG.md` | 지금까지 작업 요약 |

## 시뮬레이터

```
python3 -m sim.simulate --race barbarian --weapon greatsword --enemy ghoul -n 2000
python3 -m sim.simulate --matrix races     # 종족 x 1층
python3 -m sim.simulate --matrix weapons   # 성인식 무기 x 1층
python3 -m sim.simulate --matrix floor2    # 무기 x 2층
python3 -m sim.simulate --matrix bestiary  # 몬스터 18종 도감 (승률·라운드·남은 HP·즉사율)
python3 -m sim.simulate --log --enemy goblin --seed 3   # 전투 로그 1판
```

`sim/` 의 코드는 dict/함수만 쓰고 전투 상태를 직렬화 가능한 값으로 유지해서, GML struct + script 로 옮기기 쉽게 했다.

## 브라우저 프로토타입

마을 → 판단창 → 미궁(한 칸 이동 = 한 턴, 탭/방향키) → 지도 위 턴제 전투(적이 미리 보이고 여러 마리가 동시에 달려듦, 이동할 때마다 스킬 재사용 대기 1 회복) → 강제 귀환/사망 → 환전, 저장·이어하기까지의 한 판 루프.

```
python3 web/build.py            # web/dist/play.html (로컬·정적 호스팅), web/dist/dungeon-stone.html (Artifact 조각)
node web/tests/parity.js        # Python 참조 구현과 JS 포팅의 승률 비교 (통계적 일치 확인)
node --test web/tests/game.test.js
node web/tests/e2e.js [스크린샷 폴더]   # 실제 크로미움으로 한 판 루프 검증 (playwright 필요)
```

`web/dist/play.html` 을 휴대폰 브라우저에서 열면(정적 호스팅 또는 파일 전송) 바로 플레이할 수 있다. 모든 규칙·수치는 `data/db.json` 에서 읽는다.
