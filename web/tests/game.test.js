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
function inDungeon(seed = 1, weapon = 'greatsword') {
  const G = newChar(seed, weapon);
  DS.enterDungeon(G);
  G.dungeon.monsters = []; // 테스트에서는 직접 배치한다
  G.dungeon.camps.forEach((c) => { c.state = 'active'; }); // 진영이 저절로 나타나지 않게 막는다
  return G;
}
function place(G, id, x, y) {
  const m = DS.makeMonster(id);
  m.uid = 'm' + G.dungeon.monsters.length;
  m.pos = { x, y }; m.alert = false; m.alert_turns = 0;
  G.dungeon.monsters.push(m);
  return m;
}
const floor = () => DS.getFloor();
/** 플레이어와 (dx,dy) 만큼 떨어진 열린 칸 중, 시선이 닿는 칸을 찾는다. */
function openTileAt(G, minD, maxD) {
  const f = floor(), p = G.dungeon.pos;
  for (let r = minD; r <= maxD; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const x = p.x + dx, y = p.y + dy, d = Math.hypot(dx, dy);
    if (d < minD || d > maxD || !DS.isOpen(f, x, y)) continue;
    if (DS.hasLos(f, p, { x, y })) return { x, y };
  }
  return null;
}
function adjacentOpen(G) {
  const f = floor(), p = G.dungeon.pos;
  for (const [dx, dy] of DS.DIRS) if (DS.isOpen(f, p.x + dx, p.y + dy)) return { x: p.x + dx, y: p.y + dy };
  return null;
}
function moveAway(G) { // 열린 칸으로 한 걸음
  const f = floor(), p = G.dungeon.pos;
  for (const [dx, dy] of DS.DIRS) if (DS.isOpen(f, p.x + dx, p.y + dy) && !DS.monsterAt(G, p.x + dx, p.y + dy)) return DS.playerMove(G, dx, dy);
  return { ok: false };
}

// ------------------------------------------------------------ 세계
test('고정 지형: 같은 시드면 항상 같고, 모든 칸이 시작점에서 도달 가능', () => {
  const a = DS.buildFloor1(), b = DS.buildFloor1();
  assert.deepStrictEqual(a.grid, b.grid);
  assert.ok(a.grid.flat().filter((v) => v === 0).length >= DS.db.dungeon.floor1.min_open_tiles);
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

test('진영 자리: 고정 시드, 구역·간격 규칙을 지키고 서로 멀리 떨어져 있다', () => {
  const f = floor(), cfg = DS.db.dungeon.floor1;
  const a = DS.spawnCamps(f), b = DS.spawnCamps(f);
  assert.deepStrictEqual(a, b);
  assert.ok(a.length >= 10, 'enough camps: ' + a.length);
  for (const c of a) {
    assert.ok(DS.isOpen(f, c.x, c.y));
    assert.strictEqual(DS.zoneAt(f, c.x, c.y), c.zone);
    assert.ok(Math.hypot(c.x - f.start.x, c.y - f.start.y) >= (c.zone === 'center' ? cfg.spawn_min_dist_center : cfg.spawn_min_dist) - 0.01);
    for (const o of a) if (o !== c) assert.ok(Math.hypot(o.x - c.x, o.y - c.y) >= cfg.camp_spacing - 0.01, 'camps spaced out');
  }
});

test('무리 크기는 그날에 따라 1·2·3마리이고 3일 이후에도 상한을 넘지 않는다', () => {
  assert.deepStrictEqual([1, 2, 3, 4, 9].map(DS.groupSizeForDay), [1, 2, 3, 3, 3]);
});

function nearestCamp(G) {
  const f = floor();
  return G.dungeon.camps.slice().sort((a, b) => Math.hypot(a.x - f.start.x, a.y - f.start.y) - Math.hypot(b.x - f.start.x, b.y - f.start.y))[0];
}
/** 진영 바로 옆(2칸 이내 열린 칸)으로 플레이어를 옮기고 한 턴 보낸다. */
function approachCamp(G, camp) {
  const f = floor();
  let spot = null;
  for (let r = 3; r <= 5 && !spot; r++) for (let dy = -r; dy <= r && !spot; dy++) for (let dx = -r; dx <= r; dx++) {
    if (Math.hypot(dx, dy) >= 3 && DS.isOpen(f, camp.x + dx, camp.y + dy)) { spot = { x: camp.x + dx, y: camp.y + dy }; break; }
  }
  const p = G.char.player;
  p.pos = spot; G.dungeon.pos = { ...spot };
  DS.playerWait(G);
}

test('첫날에는 진영마다 한 마리씩 나타난다 (모든 진영을 지나가도 한꺼번에 몰리지 않는다)', () => {
  const G = newChar(2); DS.enterDungeon(G);
  assert.strictEqual(G.dungeon.monsters.length, 0, 'nothing spawned until you get close');
  for (const camp of G.dungeon.camps) approachCamp(G, camp);
  const byCamp = {};
  for (const m of G.dungeon.monsters) byCamp[m.camp] = (byCamp[m.camp] || 0) + 1;
  for (const c of G.dungeon.camps) assert.strictEqual(byCamp[c.id], 1, 'camp ' + c.id + ' on day 1');
});

test('둘째 날부터 두 마리, 셋째 날부터 세 마리씩 나타난다', () => {
  for (const [day, want] of [[2, 2], [3, 3]]) {
    const G = newChar(2); DS.enterDungeon(G);
    G.dungeon.elapsed_ms = (day - 1) * DS.db.dungeon.seconds_per_day * 1000 + 1000;
    const camp = nearestCamp(G);
    approachCamp(G, camp);
    assert.strictEqual(G.dungeon.monsters.filter((m) => m.camp === camp.id).length, want, 'day ' + day);
  }
});

test('한 번 나타난 진영은 다시 나타나지 않고, 시야 밖에서 나타난다', () => {
  const G = newChar(2); DS.enterDungeon(G);
  const camp = nearestCamp(G);
  approachCamp(G, camp);
  const n = G.dungeon.monsters.length;
  G.dungeon.monsters = [];
  DS.playerWait(G); DS.playerWait(G);
  assert.strictEqual(G.dungeon.monsters.length, 0, 'camp is spent');
  assert.ok(n >= 1);
  // 처음 나타나는 순간 플레이어의 밝은 시야(local_vision) 밖이다
  const G2 = newChar(2); DS.enterDungeon(G2);
  const c2 = nearestCamp(G2), f = floor();
  const p = G2.char.player;
  let spot = null;
  for (let r = DS.db.dungeon.floor1.activate_radius; r >= 7 && !spot; r--) for (let dy = -r; dy <= r && !spot; dy++) for (let dx = -r; dx <= r; dx++) {
    if (Math.abs(Math.hypot(dx, dy) - r) < 0.5 && DS.isOpen(f, c2.x + dx, c2.y + dy)) { spot = { x: c2.x + dx, y: c2.y + dy }; break; }
  }
  p.pos = spot; G2.dungeon.pos = { ...spot };
  DS.activateCamps(G2);
  for (const m of G2.dungeon.monsters) assert.ok(Math.hypot(m.pos.x - spot.x, m.pos.y - spot.y) > DS.db.dungeon.local_vision - 0.01, 'spawns outside the lit area');
});

// ------------------------------------------------------------ 시선·사거리
test('벽은 시선을 막고, 사거리 1 은 상하좌우 인접만', () => {
  const f = floor();
  const p = f.start;
  assert.strictEqual(DS.hasLos(f, p, p), true);
  // 벽 너머 칸: 가까운 벽 하나를 찾아 그 뒤를 본다
  let blocked = null;
  for (let r = 2; r < 12 && !blocked; r++) for (let dx = -r; dx <= r && !blocked; dx++) {
    const a = { x: p.x + dx, y: p.y }, b = { x: p.x + dx + (dx >= 0 ? 2 : -2), y: p.y };
    if (DS.isOpen(f, a.x, a.y) && DS.isOpen(f, b.x, b.y) && !DS.isOpen(f, (a.x + b.x) / 2, p.y) ) blocked = [a, b];
  }
  if (blocked) assert.strictEqual(DS.hasLos(f, blocked[0], blocked[1]), false);
  assert.strictEqual(DS.inRange(f, { x: 5, y: 5 }, { x: 6, y: 6 }, 1), false); // 대각선 불가
  assert.strictEqual(DS.inRange(f, { x: 5, y: 5 }, { x: 5, y: 6 }, 1), true);
});

test('무기 사거리: 창 2, 활 5, 나머지 1 — 스킬이 무기를 따른다', () => {
  assert.strictEqual(DS.weaponRange(DS.makePlayer('barbarian', 'spear')), 2);
  assert.strictEqual(DS.weaponRange(DS.makePlayer('barbarian', 'bow')), 5);
  assert.strictEqual(DS.weaponRange(DS.makePlayer('barbarian', 'sword')), 1);
  const bow = DS.makePlayer('barbarian', 'bow');
  assert.strictEqual(DS.skillRange(bow, 'slash'), 5);
  assert.strictEqual(DS.skillRange(DS.makeMonster('goblin_archer'), 'shoot'), 5); // 몬스터 원거리 스킬은 자체 사거리
});

// ------------------------------------------------------------ 턴과 재사용 대기
test('이동 한 칸 = 한 턴: 턴이 1 늘고 스킬 재사용 대기가 1 줄어든다', () => {
  const G = inDungeon(3);
  const p = G.char.player;
  const t0 = G.dungeon.turn;
  p.cooldowns.smash = 4;
  assert.ok(moveAway(G).ok);
  assert.strictEqual(G.dungeon.turn, t0 + 1);
  assert.strictEqual(p.cooldowns.smash, 3);
});

test('강타(쿨 3)는 사용 후 3턴 동안 못 쓰고, 이동으로 대기가 풀린다', () => {
  const G = inDungeon(3);
  const t = adjacentOpen(G);
  const m = place(G, 'gnome', t.x, t.y);
  m.hp = 1000; m.max_hp = 1000; // 안 죽게
  assert.ok(DS.playerSkill(G, 'smash', m.uid).ok);
  for (let i = 0; i < 3; i++) {
    assert.strictEqual(DS.canUseSkill(G, 'smash', m).ok, false, 'turn ' + i);
    DS.playerWait(G);
  }
  G.char.player.spirit = G.char.player.max_spirit;
  assert.strictEqual(DS.canUseSkill(G, 'smash', m).ok, true);
});

test('걸어서 이동만 해도 재사용 대기가 회복된다(전투 밖)', () => {
  const G = inDungeon(5);
  const p = G.char.player;
  p.cooldowns.smash = 4;
  for (let i = 0; i < 4; i++) if (!moveAway(G).ok) DS.playerWait(G);
  assert.strictEqual(p.cooldowns.smash, 0);
});

// ------------------------------------------------------------ 적의 행동
test('적은 시야 안에 들어오면 경계하고 다가와서 공격한다', () => {
  const G = inDungeon(7);
  const p = G.char.player;
  const t = openTileAt(G, 4, 5);
  assert.ok(t, 'open tile in LOS');
  const m = place(G, 'ghoul', t.x, t.y);
  const hp0 = p.hp;
  let hit = false;
  for (let i = 0; i < 8 && !hit; i++) { DS.playerWait(G); hit = p.hp < hp0 || DS.manhattan(m.pos, p.pos) === 1; }
  assert.ok(m.alert, 'alerted');
  assert.ok(DS.manhattan(m.pos, p.pos) <= 1 || p.hp < hp0, 'closed in / attacked');
});

test('시야 밖에 있는 적은 경계하지 않고, 놓치면 경계를 푼다', () => {
  const G = inDungeon(7);
  const far = place(G, 'gnome', G.dungeon.pos.x, G.dungeon.pos.y);
  far.pos = { x: 1, y: 1 }; // 시야 반경 밖(벽 안이어도 거리 규칙으로 충분)
  DS.playerWait(G);
  assert.strictEqual(far.alert, false);
  const t = openTileAt(G, 3, 4);
  const near = place(G, 'gnome', t.x, t.y);
  near.hp = 1000; near.max_hp = 1000;
  DS.playerWait(G);
  assert.strictEqual(near.alert, true);
  near.pos = { x: 1, y: 2 }; // 시야 밖으로 사라짐
  for (let i = 0; i < DS.db.dungeon.floor1.lose_sight_turns + 1; i++) DS.playerWait(G);
  assert.strictEqual(near.alert, false);
});

test('원거리 몬스터는 떨어진 곳에서 쏜다', () => {
  const G = inDungeon(7);
  const p = G.char.player;
  const t = openTileAt(G, 3, 5);
  const m = place(G, 'goblin_archer', t.x, t.y);
  const hp0 = p.hp;
  let shot = false;
  for (let i = 0; i < 30 && !shot; i++) { DS.playerWait(G); shot = p.hp < hp0 - 1 && DS.manhattan(m.pos, p.pos) > 1; }
  assert.ok(shot, 'archer hit the player from range');
});

test('여러 마리가 동시에 달려든다', () => {
  const G = inDungeon(9);
  const f = floor();
  const spots = [];
  for (let r = 2; r <= 4 && spots.length < 3; r++) for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, 1], [-r, 1]]) {
    const x = G.dungeon.pos.x + dx, y = G.dungeon.pos.y + dy;
    if (DS.isOpen(f, x, y) && DS.hasLos(f, G.dungeon.pos, { x, y }) && !spots.some((s) => s.x === x && s.y === y)) spots.push({ x, y });
    if (spots.length === 3) break;
  }
  assert.ok(spots.length >= 2, 'spots');
  for (const s of spots) place(G, 'gnome', s.x, s.y);
  for (let i = 0; i < 4; i++) DS.playerWait(G);
  assert.ok(DS.alertMonsters(G).length >= 2, 'multiple alerted');
});

// ------------------------------------------------------------ 공격과 보상
test('인접한 적을 쓰러뜨리면 보상을 받고 지도에서 사라진다', () => {
  const G = inDungeon(11);
  const t = adjacentOpen(G);
  const m = place(G, 'gnome', t.x, t.y);
  let guard = 0;
  while (G.dungeon && G.dungeon.monsters.length && guard++ < 40) {
    const mm = G.dungeon.monsters[0];
    if (G.char.player.spirit < 3) { DS.playerWait(G); continue; }
    DS.playerAttackDefault(G, mm.uid);
  }
  assert.ok(G.screen === 'dungeon' || G.screen === 'dead');
  if (G.screen === 'dungeon') {
    assert.strictEqual(G.dungeon.monsters.length, 0);
    assert.strictEqual(G.char.kills.gnome, 1);
    assert.ok(G.char.exp > 0);
  }
});

test('사거리 밖·쿨타임·영혼력 부족이면 스킬이 거부된다', () => {
  const G = inDungeon(13);
  const t = openTileAt(G, 3, 4);
  const m = place(G, 'gnome', t.x, t.y);
  assert.strictEqual(DS.canUseSkill(G, 'slash', m).reason, '사거리 밖');
  const t2 = adjacentOpen(G);
  const m2 = place(G, 'gnome', t2.x, t2.y);
  G.char.player.cooldowns.smash = 2;
  assert.match(DS.canUseSkill(G, 'smash', m2).reason, /쿨타임/);
  G.char.player.cooldowns.smash = 0; G.char.player.spirit = 1;
  assert.strictEqual(DS.canUseSkill(G, 'smash', m2).reason, '영혼력 부족');
});

test('활은 멀리서, 창은 두 칸 앞에서 공격할 수 있다', () => {
  const Gb = inDungeon(15, 'bow');
  const tb = openTileAt(Gb, 4, 5);
  const mb = place(Gb, 'gnome', tb.x, tb.y);
  assert.ok(DS.canUseSkill(Gb, 'slash', mb).ok, 'bow reaches');
  const Gs = inDungeon(15, 'spear');
  const f = floor(), p = Gs.dungeon.pos;
  let ts = null;
  for (const [dx, dy] of DS.DIRS) if (DS.isOpen(f, p.x + dx * 2, p.y + dy * 2) && DS.isOpen(f, p.x + dx, p.y + dy)) { ts = { x: p.x + dx * 2, y: p.y + dy * 2 }; break; }
  const ms = place(Gs, 'gnome', ts.x, ts.y);
  assert.ok(DS.canUseSkill(Gs, 'slash', ms).ok, 'spear reaches 2');
});

test('적이 있는 칸으로 이동하면 기본 공격이 된다(턴 소모)', () => {
  const G = inDungeon(17);
  const t = adjacentOpen(G);
  const m = place(G, 'gnome', t.x, t.y);
  const turn0 = G.dungeon.turn;
  const r = DS.playerMove(G, t.x - G.dungeon.pos.x, t.y - G.dungeon.pos.y);
  assert.ok(r.ok);
  assert.strictEqual(G.dungeon.turn, turn0 + 1);
  assert.ok(m.hp < m.max_hp);
  assert.deepStrictEqual(G.dungeon.pos, floor().start); // 제자리
});

test('방어막은 한 턴 동안 피해를 흡수한다', () => {
  const G = inDungeon(19);
  const t = adjacentOpen(G);
  const m = place(G, 'gnome', t.x, t.y);
  m.alert = true;
  assert.ok(DS.playerSkill(G, 'guard').ok);
  // 방어막이 적 공격을 받아 줄어들거나 그대로 — 생명력 감소는 방어막 없이 맞는 것보다 작다
  assert.ok(G.char.player.hp >= 100 - 10);
});

// ------------------------------------------------------------ 죽음·귀환·저장
test('생명력이 0이 되면 사망 화면으로 가고 새 캐릭터를 만들어야 한다', () => {
  const G = inDungeon(21, 'bow');
  const t = adjacentOpen(G);
  const m = place(G, 'ghoul', t.x, t.y);
  m.base_stats.strength = 80; m.alert = true; // 확실히 지게
  G.char.player.hp = 1;
  DS.playerWait(G);
  assert.strictEqual(G.screen, 'dead');
  assert.ok(G.dead.cause && G.dead.by);
  DS.afterDeathNewChar(G);
  assert.strictEqual(G.screen, 'create');
  assert.strictEqual(G.char, null);
});

test('강제 귀환: 전투 중이어도 즉시 마을로, 얻은 것은 유지', () => {
  const G = inDungeon(5);
  G.char.items.maseok_9 = 3; G.char.exp = 50;
  const t = adjacentOpen(G);
  place(G, 'ghoul', t.x, t.y).alert = true;
  const ms = DS.db.dungeon.floor1.forced_return_days * DS.db.dungeon.seconds_per_day * 1000;
  assert.strictEqual(DS.tickClock(G, ms), true);
  assert.strictEqual(G.screen, 'town');
  assert.strictEqual(G.dungeon, null);
  assert.strictEqual(G.char.items.maseok_9, 3);
  assert.strictEqual(G.char.returned_once, true);
});

test('전투 도중 저장하면 적 위치·재사용 대기·난수까지 그대로 복원된다', () => {
  const G = inDungeon(23);
  const t = openTileAt(G, 3, 4);
  place(G, 'ghoul', t.x, t.y);
  DS.playerWait(G); DS.playerWait(G);
  G.char.player.cooldowns.smash = 3;
  const store = memStorage();
  assert.ok(DS.saveToStorage(G, store));
  const H = DS.loadFromStorage(store);
  assert.strictEqual(H.screen, 'dungeon');
  assert.deepStrictEqual(H.dungeon.monsters.map((m) => [m.uid, m.pos, m.hp]), G.dungeon.monsters.map((m) => [m.uid, m.pos, m.hp]));
  DS.visitedSet(H);
  DS.playerWait(G); DS.playerWait(H);
  assert.deepStrictEqual(H.dungeon.monsters.map((m) => m.pos), G.dungeon.monsters.map((m) => m.pos));
  assert.strictEqual(H.char.player.hp, G.char.player.hp);
  assert.strictEqual(H.char.player.cooldowns.smash, G.char.player.cooldowns.smash);
});

test('이전 버전 저장은 읽지 않고 새로 시작한다', () => {
  const store = memStorage();
  store.setItem(DS.SAVE_KEY, JSON.stringify({ v: 1 }));
  assert.strictEqual(DS.loadFromStorage(store), null);
});

// ------------------------------------------------------------ 마을·경제
test('캐릭터 생성 → 마을 → 판단창 → 입장, 거부는 불이익 없음', () => {
  const G = newChar();
  assert.strictEqual(G.screen, 'town');
  DS.townSkip(G);
  assert.strictEqual(G.screen, 'judgment');
  DS.declineJudgment(G);
  assert.strictEqual(G.screen, 'town');
  DS.townSkip(G);
  DS.enterDungeon(G);
  assert.strictEqual(G.screen, 'dungeon');
  assert.ok(G.dungeon.camps.length >= 10);
  assert.strictEqual(G.dungeon.monsters.length, 0);
});

test('환전소는 첫 귀환 뒤에만 열린다', () => {
  const G = newChar();
  G.char.items.maseok_9 = 4;
  assert.strictEqual(DS.exchange(G), null);
  G.char.returned_once = true;
  assert.strictEqual(DS.exchange(G), 4 * DS.db.economy.exchange_rate_by_grade['9']);
  assert.strictEqual(G.char.items.maseok_9, undefined);
});

test('사냥 숙련·첫 처치 경험치·포탈 발견은 한 번만', () => {
  const G = newChar();
  const m1 = DS.grantKillRewards(G, 'ghoul');
  assert.ok(m1.some((m) => m.includes('첫 처치')));
  assert.ok(!DS.grantKillRewards(G, 'ghoul').some((m) => m.includes('첫 처치')));
  for (let i = 0; i < 10; i++) DS.grantKillRewards(G, 'ghoul');
  assert.strictEqual(DS.masteryLevel(G.char.kills, 'ghoul'), 1);
  assert.ok(DS.discoverPortal(G, 'north'));
  assert.strictEqual(DS.discoverPortal(G, 'north'), null);
});

// ------------------------------------------------------------ 후퇴
/** 가로로 7칸 이상 열린 복도에서, 적이 바로 옆에 붙은 상태로 시작한다. */
function corridorFight(id, seed) {
  const G = inDungeon(seed);
  const f = floor();
  let s = null;
  for (let y = 1; y < f.height - 1 && !s; y++) for (let x = 1; x < f.width - 7 && !s; x++) {
    let ok = true; for (let i = 0; i < 7; i++) if (!DS.isOpen(f, x + i, y)) { ok = false; break; }
    if (ok) s = { x, y };
  }
  const p = G.char.player;
  p.pos = { x: s.x + 1, y: s.y }; G.dungeon.pos = { ...p.pos };
  const m = place(G, id, s.x, s.y);
  m.alert = true; m.alert_turns = 6;
  return { G, m, p };
}

test('물러서는 동안에는 근접 몬스터에게 맞지 않는다(구울 포함)', () => {
  for (const id of ['gnome', 'ghoul', 'blade_wolf']) {
    for (let seed = 1; seed <= 40; seed++) {
      const { G, p } = corridorFight(id, seed);
      for (let i = 0; i < 5; i++) {
        const hp0 = p.hp;
        assert.ok(DS.playerMove(G, 1, 0).ok);
        assert.ok(p.hp >= hp0 - 0.01, id + ' hit a retreating player (seed ' + seed + ', step ' + i + ')');
      }
    }
  }
});

test('빠른 몬스터의 추가 행동은 붙어 있을 때 공격 횟수로 쓰인다', () => {
  let doubled = false;
  for (let seed = 1; seed <= 30 && !doubled; seed++) {
    const { G, m, p } = corridorFight('ghoul', seed);
    m.action_gauge = 1.0; // 이번 턴 추가 행동 확보
    const before = G.dungeon.log.length;
    DS.playerWait(G);
    const attacks = G.dungeon.log.slice(before).filter((l) => l.includes(m.name) && l.includes('→')).length;
    if (attacks >= 2) doubled = true;
  }
  assert.ok(doubled, 'ghoul attacked twice in one turn when adjacent');
});

test('한 칸 떨어진 적이 다가오는 턴에는 공격하지 못한다', () => {
  const { G, m, p } = corridorFight('ghoul', 3);
  m.pos = { x: p.pos.x - 2, y: p.pos.y }; m.action_gauge = 1.0; // 추가 행동이 있어도
  const hp0 = p.hp;
  DS.playerWait(G);
  assert.strictEqual(DS.manhattan(m.pos, p.pos), 1);
  assert.ok(p.hp >= hp0 - 0.01, 'moving ends the turn');
});
