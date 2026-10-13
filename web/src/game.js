/* 게임 상태와 진행 규칙(DOM 없음). 화면 전환·저장·시계·전투 연결.
 * G 는 순수 JSON 이라 localStorage 에 그대로 저장되고, 전투 도중 상태까지 복원된다(기획서 2-2). */
const DS = (globalThis.DS = globalThis.DS || {});

DS.SAVE_KEY = 'dungeon_stone_save_v1';

DS.newGame = function (seed) {
  return {
    v: 1, screen: 'create', rng: DS.newRng(seed || Date.now()), auto: false,
    char: null, town: { day: 1 }, dungeon: null, battle: null, judgment: null, dead: null, msgs: [],
  };
};

DS.createChar = function (G, weaponId) {
  G.char = {
    player: DS.makePlayer('barbarian', weaponId),
    weapon: weaponId, exp: 0, kills: {}, stones: DS.db.economy.start_stones,
    items: {}, portals: [], returned_once: false, born_at_day: 1,
  };
  G.town = { day: 1 };
  G.auto = false;
  G.screen = 'town';
  G.msgs.push('성인식을 마쳤습니다. 마을에서 시작합니다.');
};

DS.level = function (G) { return DS.expToLevel(G.char.exp); };

// ------------------------------------------------------------ 마을 / 판단창
DS.townSkip = function (G) {
  G.town.day += DS.db.dungeon.judgment_interval_days;
  healFully(G.char.player);
  DS.openJudgment(G);
};

DS.openJudgment = function (G) {
  G.judgment = { remaining_ms: DS.db.dungeon.judgment_seconds * 1000 };
  G.screen = 'judgment';
};

DS.declineJudgment = function (G) {
  G.judgment = null;
  G.screen = 'town';
  G.msgs.push('입장을 거부했습니다. 다음 주기를 기다립니다.');
};

function healFully(p) {
  p.hp = p.max_hp;
  p.spirit = p.max_spirit;
  clearBattleState(p);
}

function clearBattleState(p) {
  p.cooldowns = {}; p.status = {}; p.stunned = false; p.shield = 0;
  p.damaged_parts = []; p.part_penalty = {}; p.vs_bonus = {}; p.action_gauge = 0;
}

// ------------------------------------------------------------ 미궁 진입 / 이동
DS.enterDungeon = function (G) {
  const floor = DS.getFloor();
  const key = (x, y) => y * floor.width + x;
  G.judgment = null;
  G.dungeon = {
    elapsed_ms: 0, pos: { x: floor.start.x, y: floor.start.y }, steps: 0,
    visited: [key(floor.start.x, floor.start.y)], group: null,
  };
  healFully(G.char.player);
  G.screen = 'dungeon';
  G.msgs.push('미궁에 들어섰습니다. 미궁 시계가 흐르기 시작합니다.');
};

DS.getFloor = function () {
  if (!DS._floor) DS._floor = DS.buildFloor1();
  return DS._floor;
};

DS.visitedSet = function (G) {
  if (!G.dungeon._vset) Object.defineProperty(G.dungeon, '_vset', { value: new Set(G.dungeon.visited), enumerable: false, writable: true });
  return G.dungeon._vset;
};

/** 한 칸 이동(실시간 이동의 한 걸음). 이동했으면 true. 조우하면 전투 화면으로 넘어간다. */
DS.stepTo = function (G, x, y) {
  const floor = DS.getFloor();
  const d = G.dungeon;
  if (G.screen !== 'dungeon' || !DS.isOpen(floor, x, y)) return false;
  if (Math.abs(x - d.pos.x) + Math.abs(y - d.pos.y) !== 1) return false;
  d.pos = { x, y };
  d.steps += 1;
  const k = y * floor.width + x;
  const vs = DS.visitedSet(G);
  if (!vs.has(k)) { vs.add(k); d.visited.push(k); }
  const p = G.char.player;
  p.hp = Math.min(p.max_hp, p.hp + p.max_hp * DS.db.dungeon.step_heal_pct); // 4-5: 안전한 이동 한 칸마다 소량 회복
  for (const portal of floor.portals) {
    if (portal.x === x && portal.y === y) {
      const msgs = DS.discoverPortal(G, portal.id);
      if (msgs) G.msgs.push(...msgs, '2층은 아직 준비 중입니다.');
    }
  }
  const enc = DS.rollEncounter(G, floor, x, y);
  if (enc) {
    d.group = { enemies: enc.enemies, index: 0, zone: enc.zone };
    DS.startBattle(G);
  }
  return true;
};

// ------------------------------------------------------------ 전투 연결
DS.startBattle = function (G) {
  const g = G.dungeon.group;
  const enemyId = g.enemies[g.index];
  const p = G.char.player;
  clearBattleState(p);
  p.spirit = p.max_spirit; // 전투마다 영혼력은 가득 찬 상태로 시작
  DS.applyMastery(p, DS.masteryLevel(G.char.kills, enemyId));
  const enemy = DS.makeEnemy(enemyId);
  G.battle = DS.newCombat([p], enemy, Math.floor(DS.rand(G.rng) * 4294967296));
  G.battleStats = null;
  G.screen = 'battle';
};

/** 플레이어 한 라운드(수동이면 skillId 지정, 자동이면 null). 끝났으면 결과 문자열. */
DS.battleAct = function (G, skillId) {
  const st = G.battle;
  const before = st.log.length;
  DS.runRound(st, skillId || null);
  const fresh = st.log.slice(before);
  if (!st.result) return null;
  return DS.finishBattle(G, fresh);
};

DS.finishBattle = function (G, freshLog) {
  const st = G.battle;
  const g = G.dungeon.group;
  const enemyId = g.enemies[g.index];
  const p = G.char.player;
  if (st.result === 'defeat') {
    G.dead = {
      cause: st.instakill ? '헤드샷 즉사' : '전투 패배', by: DS.db.monsters[enemyId] ? DS.db.monsters[enemyId].name_ko : enemyId,
      kills: Object.values(G.char.kills).reduce((a, b) => a + b, 0), level: DS.level(G),
      days: Math.floor(G.dungeon.elapsed_ms / 1000 / DS.db.dungeon.seconds_per_day) + 1, steps: G.dungeon.steps,
    };
    G.battle = null; G.dungeon = null; G.screen = 'dead';
    return 'defeat';
  }
  const msgs = DS.grantKillRewards(G, enemyId);
  G.msgs.push(...msgs);
  clearBattleState(p);
  g.index += 1;
  G.battle = null;
  if (g.index < g.enemies.length) {
    G.msgs.push('무리 ' + (g.index + 1) + '/' + g.enemies.length);
    DS.startBattle(G);
    return 'next';
  }
  G.dungeon.group = null;
  G.screen = 'dungeon';
  return 'victory';
};

// ------------------------------------------------------------ 미궁 시계 / 강제 귀환
DS.dungeonDays = function (G) {
  return G.dungeon ? G.dungeon.elapsed_ms / 1000 / DS.db.dungeon.seconds_per_day : 0;
};

/** 미궁 시계 진행(전투 중에도 흐른다). 강제 귀환이 일어나면 true. */
DS.tickClock = function (G, dtMs) {
  if (!G.dungeon || (G.screen !== 'dungeon' && G.screen !== 'battle')) return false;
  G.dungeon.elapsed_ms += dtMs;
  if (DS.dungeonDays(G) >= DS.db.dungeon.floor1.forced_return_days) {
    DS.forcedReturn(G);
    return true;
  }
  return false;
};

DS.forcedReturn = function (G) {
  // 사망이 아니므로 얻은 것은 모두 유지. 전투 중이어도 즉시 귀환.
  G.battle = null; G.dungeon = null;
  G.char.returned_once = true;
  G.town.day += 1;
  healFully(G.char.player);
  G.screen = 'town';
  G.msgs.push('정해진 체류일이 지나 마을로 강제 귀환했습니다. (사망이 아닙니다)');
};

DS.exchange = function (G) {
  if (!G.char.returned_once) return null;
  return DS.exchangeAll(G);
};

// ------------------------------------------------------------ 저장 / 이어하기
DS.serialize = function (G) {
  return JSON.stringify(G, (k, v) => (k === 'msgs' ? [] : v));
};

DS.deserialize = function (text) {
  const G = JSON.parse(text);
  if (G.v !== 1) throw new Error('save version mismatch');
  G.msgs = [];
  if (G.battle && G.char) G.char.player = G.battle.allies[0]; // 전투 도중 저장: 참조 복원
  G.auto = false; // 껐다 켜면 수동으로 돌아간다(4-10)
  return G;
};

DS.saveToStorage = function (G, storage) {
  try { storage.setItem(DS.SAVE_KEY, DS.serialize(G)); return true; } catch (e) { return false; }
};

DS.loadFromStorage = function (storage) {
  try {
    const t = storage.getItem(DS.SAVE_KEY);
    return t ? DS.deserialize(t) : null;
  } catch (e) { return null; }
};

DS.clearSave = function (storage) {
  try { storage.removeItem(DS.SAVE_KEY); } catch (e) { /* 저장소를 못 쓰는 환경 */ }
};

DS.afterDeathNewChar = function (G) {
  G.char = null; G.dead = null; G.dungeon = null; G.battle = null; G.auto = false;
  G.screen = 'create';
};
