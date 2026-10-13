# 던전 앤 스톤 (gamemaker1)

GameMaker(GML)로 만드는 영구사망 서바이벌 RPG. 기획서는 [`docs/design_notes_v6.md`](docs/design_notes_v6.md).

## 구조

| 경로 | 내용 |
|---|---|
| `data/db.json` | 모든 고정값(규칙 수치·스킬·종족·장비·몬스터). 코드에 숫자를 하드코딩하지 않는다 |
| `sim/` | 전투 코어의 Python 참조 구현 + 밸런스 시뮬레이터. 나중에 GML script 로 이식할 규칙의 기준 |
| `tests/` | 전투 규칙 단위 테스트 (`python3 -m unittest discover -s tests -t .`) |
| `docs/implementation_notes.md` | 구현하며 정한 임시 규칙, 시뮬레이션 결과, 다음 할 일 |

## 시뮬레이터

```
python3 -m sim.simulate --race barbarian --weapon greatsword --enemy ghoul -n 2000
python3 -m sim.simulate --matrix races     # 종족 x 1층
python3 -m sim.simulate --matrix weapons   # 성인식 무기 x 1층
python3 -m sim.simulate --matrix floor2    # 무기 x 2층
python3 -m sim.simulate --log --enemy goblin --seed 3   # 전투 로그 1판
```

`sim/` 의 코드는 dict/함수만 쓰고 전투 상태를 직렬화 가능한 값으로 유지해서, GML struct + script 로 옮기기 쉽게 했다.
