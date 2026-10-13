/* 게임 상태와 진행 규칙(DOM 없음). 화면 전환·저장·시계·전투 연결.
 * G 는 순수 JSON 이라 localStorage 에 그대로 저장되고, 전투 도중 상태까지 복원된다(기획서 2-2). */
const DS = (globalThis.DS = globalThis.DS || {});

DS.SAVE_KEY = 'dungeon_stone_save_v2';

DS.newGame = function (seed) {
  return {
    v: 2, screen: 'create', rng: DS.newRng(seed || Date.now()),
    char: null, town: { day: 1 }, dungeon: null, judgment: null, dead: null, msgs: [],
  };
};

DS.createChar = function (G, weaponId) {
  G.char = {
    player: DS.makePlayer('barbarian', weaponId),
    weapon: weaponId, exp: 0, kills: {}, stones: DS.db.economy.start_stones,
    items: {}, portals: [], returned_once: false, born_at_day: 1,
  };
  G.town = { day: 1 };
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

// ------------------------------------------------------------ 미궁 진입
DS.enterDungeon = function (G) {
  const floor = DS.getFloor();
  const key = (x, y) => y * floor.width + x;
  G.judgment = null;
  const p = G.char.player;
  p.pos = { x: floor.start.x, y: floor.start.y };
  G.dungeon = {
    elapsed_ms: 0, pos: { x: floor.start.x, y: floor.start.y }, steps: 0, turn: 0,
    visited: [key(floor.start.x, floor.start.y)], monsters: [], camps: DS.spawnCamps(floor), log: [], day: 1,
  };
  healFully(p);
  G.screen = 'dungeon';
  G.msgs.push('미궁에 들어섰습니다. 한 칸 이동이 한 턴이고, 이동할 때마다 스킬 재사용 대기가 줄어듭니다.');
};

DS.getFloor = function () {
  if (!DS._floor) DS._floor = DS.buildFloor1();
  return DS._floor;
};

DS.visitedSet = function (G) {
  if (!G.dungeon._vset) Object.defineProperty(G.dungeon, '_vset', { value: new Set(G.dungeon.visited), enumerable: false, writable: true });
  return G.dungeon._vset;
};

// ------------------------------------------------------------ 미궁 시계 / 강제 귀환
DS.dungeonDays = function (G) {
  return G.dungeon ? G.dungeon.elapsed_ms / 1000 / DS.db.dungeon.seconds_per_day : 0;
};

/** 미궁 시계 진행(전투 중에도 흐른다). 강제 귀환이 일어나면 true. */
DS.tickClock = function (G, dtMs) {
  if (!G.dungeon || G.screen !== 'dungeon') return false;
  G.dungeon.elapsed_ms += dtMs;
  const day = DS.dungeonDay(G);
  if (day > G.dungeon.day) {
    G.dungeon.day = day;
    G.msgs.push('미궁 ' + day + '일째입니다. 지금부터 새로 마주치는 몬스터는 ' + DS.groupSizeForDay(day) + '마리씩 무리를 짓습니다.');
  }
  if (DS.dungeonDays(G) >= DS.db.dungeon.floor1.forced_return_days) {
    DS.forcedReturn(G);
    return true;
  }
  return false;
};

DS.forcedReturn = function (G) {
  // 사망이 아니므로 얻은 것은 모두 유지. 전투 중이어도 즉시 귀환.
  G.dungeon = null;
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
  if (G.v !== 2) throw new Error('save version mismatch');
  G.msgs = [];
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
  G.char = null; G.dead = null; G.dungeon = null;
  G.screen = 'create';
};
