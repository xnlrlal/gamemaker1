const test = require('node:test');
const assert = require('node:assert');
const DS = require('./load');

function memStorage() {
  const m = {};
  return { setItem: (k, v) => { m[k] = v; }, getItem: (k) => (k in m ? m[k] : null), removeItem: (k) => { delete m[k]; } };
}
function newChar(seed = 1, weapon = 'greatsword') {
  const G = DS.newGame(seed);
  DS.createChar(G, weapon);
  return G;
}
// 조우가 날 때까지 걷는다(항상 열린 인접 칸으로)
function walkUntilBattle(G, maxSteps = 4000) {
  const floor = DS.getFloor();
  let dir = 0;
  for (let i = 0; i < maxSteps && G.screen === 'dungeon'; i++) {
    const { x, y } = G.dungeon.pos;
    for (let t = 0; t < 4; t++) {
      const [dx, dy] = DS.DIRS[(dir + t) % 4];
      if (DS.isOpen(floor, x + dx, y + dy)) { dir = (dir + t) % 4; DS.stepTo(G, x + dx, y + dy); break; }
    }
    if (Math.random() < 0.3) dir = (dir + 1) % 4;
  }
}

test('고정 지형: 같은 시드면 항상 같고, 모든 칸이 시작점에서 도달 가능', () => {
  const a = DS.buildFloor1(), b = DS.buildFloor1();
  assert.deepStrictEqual(a.grid, b.grid);
  const open = a.grid.flat().filter((v) => v === 0).length;
  assert.ok(open >= DS.db.dungeon.floor1.min_open_tiles);
  for (const p of a.portals) assert.ok(DS.findPath(a, a.start, p), 'portal ' + p.id + ' unreachable');
  const zones = new Set();
  a.grid.forEach((row, y) => row.forEach((v, x) => { if (v === 0) zones.add(DS.zoneAt(a, x, y)); }));
  assert.deepStrictEqual([...zones].sort(), ['center', 'east', 'north', 'south', 'west']);
});

test('구역별 몬스터는 기획서 6-2 와 일치, 중심부는 4구역 혼합', () => {
  assert.deepStrictEqual(DS.monstersInZone('west'), ['ghoul']);
  assert.deepStrictEqual(DS.monstersInZone('south'), ['goblin']);
  assert.strictEqual(DS.monstersInZone('center').length, 4);
});

test('무리 크기는 체류일에 따라 늘고 상한이 있다', () => {
  assert.strictEqual(DS.groupSize(0), 1);
  assert.ok(DS.groupSize(1.7) >= 3);
  assert.strictEqual(DS.groupSize(99), DS.db.dungeon.floor1.group_max);
});

test('캐릭터 생성 → 마을 → 판단창 → 입장', () => {
  const G = newChar();
  assert.strictEqual(G.screen, 'town');
  DS.townSkip(G);
  assert.strictEqual(G.screen, 'judgment');
  DS.enterDungeon(G);
  assert.strictEqual(G.screen, 'dungeon');
  assert.deepStrictEqual(G.dungeon.pos, DS.getFloor().start);
});

test('판단창 거부는 불이익 없이 마을로 돌아온다', () => {
  const G = newChar();
  DS.townSkip(G);
  DS.declineJudgment(G);
  assert.strictEqual(G.screen, 'town');
  assert.ok(G.char.player.hp === G.char.player.max_hp);
});

test('걷다 보면 조우하고 전투가 끝나면 무리가 이어진다', () => {
  const G = newChar(7);
  DS.enterDungeon(G);
  walkUntilBattle(G);
  assert.strictEqual(G.screen, 'battle');
  const total = G.dungeon.group.enemies.length;
  let guard = 0, finished = null;
  while (G.screen === 'battle' && guard++ < 5000) finished = DS.battleAct(G, null);
  assert.ok(['victory', 'defeat', 'next'].includes(finished) || G.screen !== 'battle');
  assert.ok(total >= 1);
});

test('수동 스킬 지정은 첫 행동에 쓰이고 쿨타임이 걸린다', () => {
  const G = newChar(3);
  DS.enterDungeon(G);
  walkUntilBattle(G);
  const p = G.battle.allies[0];
  const spiritBefore = p.spirit;
  DS.battleAct(G, 'smash');
  if (G.screen === 'battle') {
    assert.strictEqual(p.cooldowns.smash, DS.db.skills.smash.cooldown); // 사용 +1, 라운드 종료 -1
    assert.ok(p.spirit < spiritBefore);
  }
});

test('전투 도중 저장하면 그대로 복원된다(참조·난수 포함)', () => {
  const G = newChar(11);
  DS.enterDungeon(G);
  walkUntilBattle(G);
  assert.strictEqual(G.screen, 'battle');
  DS.battleAct(G, 'slash');
  const store = memStorage();
  assert.ok(DS.saveToStorage(G, store));
  const H = DS.loadFromStorage(store);
  assert.strictEqual(H.screen, G.screen);
  assert.strictEqual(H.char.player, H.battle.allies[0]); // 참조 복원
  assert.strictEqual(H.auto, false);
  // 같은 입력이면 같은 결과(난수 상태까지 복원)
  DS.battleAct(G, 'slash');
  DS.battleAct(H, 'slash');
  if (G.battle && H.battle) {
    assert.strictEqual(G.battle.allies[0].hp, H.battle.allies[0].hp);
    assert.strictEqual(G.battle.enemy.hp, H.battle.enemy.hp);
  } else {
    assert.strictEqual(G.screen, H.screen);
  }
});

test('강제 귀환: 전투 중이어도 즉시 마을로, 얻은 것은 유지', () => {
  const G = newChar(5);
  DS.enterDungeon(G);
  G.char.items.maseok_9 = 3;
  G.char.exp = 50;
  walkUntilBattle(G);
  assert.strictEqual(G.screen, 'battle');
  const ms = DS.db.dungeon.floor1.forced_return_days * DS.db.dungeon.seconds_per_day * 1000;
  assert.strictEqual(DS.tickClock(G, ms), true);
  assert.strictEqual(G.screen, 'town');
  assert.strictEqual(G.battle, null);
  assert.strictEqual(G.char.items.maseok_9, 3);
  assert.strictEqual(G.char.exp, 50);
  assert.strictEqual(G.char.returned_once, true);
});

test('환전소는 첫 귀환 뒤에만 열린다', () => {
  const G = newChar();
  G.char.items.maseok_9 = 4;
  assert.strictEqual(DS.exchange(G), null);
  G.char.returned_once = true;
  assert.strictEqual(DS.exchange(G), 4 * DS.db.economy.exchange_rate_by_grade['9']);
  assert.strictEqual(G.char.stones, 40);
  assert.strictEqual(G.char.items.maseok_9, undefined);
});

test('사망하면 새 캐릭터를 만들어야 하고 모든 진행이 초기화된다', () => {
  const G = newChar(2, 'bow');
  DS.enterDungeon(G);
  walkUntilBattle(G);
  G.battle.allies[0].hp = 0.1;
  G.battle.enemy.base_stats.strength = 50; // 확실히 지게
  let guard = 0;
  while (G.screen === 'battle' && guard++ < 500) DS.battleAct(G, null);
  assert.strictEqual(G.screen, 'dead');
  assert.ok(G.dead.cause);
  DS.afterDeathNewChar(G);
  assert.strictEqual(G.screen, 'create');
  assert.strictEqual(G.char, null);
});

test('사냥 숙련·첫 처치 경험치·포탈 발견은 한 번만', () => {
  const G = newChar();
  const m1 = DS.grantKillRewards(G, 'ghoul');
  assert.ok(m1.some((m) => m.includes('첫 처치')));
  const m2 = DS.grantKillRewards(G, 'ghoul');
  assert.ok(!m2.some((m) => m.includes('첫 처치')));
  for (let i = 0; i < 10; i++) DS.grantKillRewards(G, 'ghoul');
  assert.strictEqual(DS.masteryLevel(G.char.kills, 'ghoul'), 1); // 12회 처치
  assert.ok(DS.discoverPortal(G, 'north'));
  assert.strictEqual(DS.discoverPortal(G, 'north'), null);
});

test('예상 승률은 원본 상태를 건드리지 않는다', () => {
  const G = newChar(9);
  DS.enterDungeon(G);
  walkUntilBattle(G);
  const snap = JSON.stringify(G.battle);
  const p = DS.estimateWinRate(G.battle, 100);
  assert.ok(p >= 0 && p <= 1);
  assert.strictEqual(JSON.stringify(G.battle), snap);
});
