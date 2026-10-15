/* 지도 위 턴제 전투. 이동 한 칸 = 한 턴. 매 턴 모든 스킬의 재사용 대기가 1씩 줄고 적이 한 번씩 움직인다.
 * 판정(명중·치명·피해·상태이상·부위 손상)은 combat.js 의 규칙 함수를 그대로 재사용한다. 상태는 순수 JSON. */
const DS = (globalThis.DS = globalThis.DS || {});

// ------------------------------------------------------------ 위치·시선·사거리
DS.manhattan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/** 두 칸 사이를 벽이 가로막지 않는가(브레즌햄 선, 양 끝 제외). */
DS.hasLos = function (floor, a, b) {
  let x = a.x, y = a.y;
  const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
  const sx = a.x < b.x ? 1 : -1, sy = a.y < b.y ? 1 : -1;
  let err = dx - dy;
  while (x !== b.x || y !== b.y) {
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
    if ((x !== b.x || y !== b.y) && !DS.isOpen(floor, x, y)) return false;
  }
  return true;
};

/** 사거리 1 = 상하좌우 인접만(대각선 불가). 2 이상은 직선거리, 시선이 필요하다. */
DS.inRange = function (floor, a, b, range) {
  if (range <= 1) return DS.manhattan(a, b) === 1;
  return Math.hypot(a.x - b.x, a.y - b.y) <= range + 0.01 && DS.hasLos(floor, a, b);
};

DS.weaponRange = function (actor) {
  const w = actor.gear.find((g) => g.slot === 'weapon' && g.range);
  return w ? w.range : 1;
};

DS.skillRange = function (actor, sid) {
  const s = DS.db.skills[sid];
  return s.range || DS.weaponRange(actor);
};

/** 막힌 칸(blocked)을 피하는 BFS 경로. 도착 칸은 막혀 있어도 허용. */
DS.findPathAvoiding = function (floor, from, to, blocked) {
  const W = floor.width;
  const key = (x, y) => y * W + x;
  const prev = new Map([[key(from.x, from.y), null]]);
  const q = [from];
  for (let i = 0; i < q.length && i < 4000; i++) {
    const c = q[i];
    if (c.x === to.x && c.y === to.y) break;
    for (const [dx, dy] of DS.DIRS) {
      const x = c.x + dx, y = c.y + dy, k = key(x, y);
      if (!DS.isOpen(floor, x, y) || prev.has(k)) continue;
      if (blocked.has(k) && !(x === to.x && y === to.y)) continue;
      prev.set(k, c); q.push({ x, y });
    }
  }
  if (!prev.has(key(to.x, to.y))) return null;
  const path = [];
  for (let c = to; c && !(c.x === from.x && c.y === from.y); c = prev.get(key(c.x, c.y))) path.push({ x: c.x, y: c.y });
  return path.reverse();
};

// ------------------------------------------------------------ 몬스터 배치(고정 세계)
/** 몬스터 진영 자리: 구역마다 고정 시드로 정한다(같은 세계는 항상 같은 자리). 간격을 넓게 둬서 한꺼번에 몰리지 않게 한다. */
DS.spawnCamps = function (floor) {
  const cfg = DS.db.dungeon.floor1;
  const rng = DS.newRng(DS.db.dungeon.world_seed + 999);
  const open = [];
  floor.grid.forEach((row, y) => row.forEach((v, x) => { if (v === 0) open.push({ x, y }); }));
  const camps = [];
  for (const zone of ['north', 'east', 'south', 'west', 'center']) {
    const want = zone === 'center' ? cfg.camps_center : cfg.camps_per_zone;
    const minDist = zone === 'center' ? cfg.spawn_min_dist_center : cfg.spawn_min_dist;
    const pool = open.filter((t) => DS.zoneAt(floor, t.x, t.y) === zone && Math.hypot(t.x - floor.start.x, t.y - floor.start.y) >= minDist);
    for (let n = 0, tries = 0; n < want && tries < 800 && pool.length; tries++) {
      const t = DS.choice(rng, pool);
      if (camps.some((c) => Math.hypot(c.x - t.x, c.y - t.y) < cfg.camp_spacing)) continue;
      camps.push({ id: camps.length, x: t.x, y: t.y, zone, state: 'dormant', min_dist: minDist });
      n++;
    }
  }
  return camps;
};

/** 미궁 n일째에 새로 만나는 무리의 크기(기획서 7-1: 첫날 단독 → 점차 늘어남). */
DS.groupSizeForDay = function (day) {
  const arr = DS.db.dungeon.floor1.group_by_day;
  return arr[Math.min(Math.max(1, day), arr.length) - 1];
};

DS.dungeonDay = function (G) { return Math.floor(DS.dungeonDays(G)) + 1; };

/** 플레이어가 진영에 가까이 가면(시야 밖에서) 그날의 크기만큼 몬스터가 나타난다. 한 번 나타난 진영은 다시 나오지 않는다. */
DS.activateCamps = function (G) {
  const d = G.dungeon, floor = DS.getFloor(), cfg = DS.db.dungeon.floor1, p = G.char.player;
  let spawned = 0;
  for (const camp of d.camps) {
    if (camp.state !== 'dormant' || Math.hypot(camp.x - p.pos.x, camp.y - p.pos.y) > cfg.activate_radius) continue;
    camp.state = 'active';
    const size = DS.groupSizeForDay(DS.dungeonDay(G));
    const rng = DS.newRng(DS.db.dungeon.world_seed + 7919 * (camp.id + 1) + size); // 같은 진영·같은 크기면 항상 같은 무리
    const ids = DS.monstersInZone(camp.zone);
    const occupied = new Set(d.monsters.filter((m) => m.alive).map((m) => m.pos.y * floor.width + m.pos.x));
    occupied.add(p.pos.y * floor.width + p.pos.x);
    for (let k = 0; k < size; k++) {
      const near = [];
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const x = camp.x + dx, y = camp.y + dy;
        if (DS.isOpen(floor, x, y) && Math.hypot(dx, dy) <= 2 && !occupied.has(y * floor.width + x)
          && DS.zoneAt(floor, x, y) === camp.zone && Math.hypot(x - floor.start.x, y - floor.start.y) >= camp.min_dist) near.push({ x, y });
      }
      if (!near.length) break;
      const spot = DS.choice(rng, near);
      occupied.add(spot.y * floor.width + spot.x);
      const m = DS.makeMonster(DS.choice(rng, ids));
      m.uid = 'c' + camp.id + '_' + k;
      m.camp = camp.id;
      m.pos = spot; m.alert = false; m.alert_turns = 0;
      d.monsters.push(m);
      spawned++;
    }
  }
  return spawned;
};

DS.monsterAt = function (G, x, y) {
  return G.dungeon.monsters.find((m) => m.alive && m.pos.x === x && m.pos.y === y) || null;
};

DS.alertMonsters = function (G) { return G.dungeon.monsters.filter((m) => m.alive && m.alert); };

// ------------------------------------------------------------ 전투 상태(판정 함수 재사용용)
function tstate(G) {
  const d = G.dungeon;
  if (!d._ts) {
    Object.defineProperty(d, '_ts', { value: { round: d.turn, rng: G.rng, log: [], result: null, instakill: false, policies: {}, allies: [G.char.player], enemy: null, logPrefix: 'T' }, enumerable: false, writable: true });
  }
  d._ts.round = d.turn; d._ts.rng = G.rng; d._ts.allies = [G.char.player];
  return d._ts;
}

function flushLog(G, ts) {
  const d = G.dungeon;
  d.log.push(...ts.log.splice(0));
  if (d.log.length > 60) d.log.splice(0, d.log.length - 60);
}

function applyMasteryFor(G, target) {
  DS.applyMastery(G.char.player, DS.masteryLevel(G.char.kills, target.id));
}

/** 스킬 사용 공통부(영혼력·재사용 대기). 쿨타임 N(>=1) = 사용 후 N턴 동안 사용 불가, 0 = 제한 없음. */
function spend(actor, sid) {
  const s = DS.db.skills[sid];
  actor.spirit -= s.cost;
  actor.cooldowns[sid] = s.cooldown > 0 ? s.cooldown + 1 : 0;
}

function useSkill(G, ts, actor, sid, target) {
  const s = DS.db.skills[sid];
  spend(actor, sid);
  if (s.kind === 'defend') {
    const amount = s.shield_base + DS.effStat(actor, 'phys_res') * s.shield_per_phys_res;
    actor.shield += amount;
    ts.log.push('T' + ts.round + ' ' + actor.name + ' ' + s.name_ko + ' 방어막 ' + (Math.round(amount * 10) / 10).toFixed(1));
    return;
  }
  if (actor.is_player) applyMasteryFor(G, target); else applyMasteryFor(G, actor);
  DS.resolveAttack(ts, actor, target, sid);
}

// ------------------------------------------------------------ 몬스터 한 턴
function monsterChoose(G, m, p) {
  const floor = DS.getFloor();
  const rules = DS.db.rules;
  const usable = m.skills.filter((sid) => (m.cooldowns[sid] || 0) <= 0 && m.spirit >= DS.db.skills[sid].cost);
  if (m.ai === 'guard_when_hurt' && m.hp < m.max_hp * rules.ai.guard_hp_threshold) {
    const g = usable.find((sid) => DS.db.skills[sid].kind === 'defend');
    if (g) return { sid: g, self: true };
  }
  const reach = usable.filter((sid) => DS.db.skills[sid].kind === 'attack' && DS.inRange(floor, m.pos, p.pos, DS.skillRange(m, sid)));
  if (!reach.length) return null;
  let best = reach[0], bv = -1;
  for (const sid of reach) {
    const v = DS.skillValue(null, m, sid);
    if (v > bv) { best = sid; bv = v; }
  }
  return { sid: best, self: false };
}

function monsterTurn(G, ts, m) {
  const floor = DS.getFloor(), cfg = DS.db.dungeon.floor1, p = G.char.player;
  const dist = Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y);
  // 처음 눈치채는 건 둘러싼 8칸(aggro_radius) 안에 들어왔을 때뿐 — 멀리서 보이는 것만으로는 선공하지 않는다.
  // 한 번 눈치챈 뒤에는 시야 반경 안에서 시선이 닿는 동안 계속 쫓는다.
  const near = Math.max(Math.abs(m.pos.x - p.pos.x), Math.abs(m.pos.y - p.pos.y)) <= cfg.aggro_radius;
  const sees = m.alert ? dist <= cfg.sight_radius && DS.hasLos(floor, m.pos, p.pos) : near;
  if (sees) {
    if (!m.alert) { ts.log.push('T' + ts.round + ' ' + m.name + '이(가) 당신을 발견했다!'); m.alert = true; }
    m.alert_turns = cfg.lose_sight_turns;
  } else if (m.alert) {
    m.alert_turns -= 1;
    if (m.alert_turns <= 0) { m.alert = false; ts.log.push('T' + ts.round + ' ' + m.name + '이(가) 당신을 놓쳤다.'); }
  }
  if (!m.alert) return;
  m.shield = 0; // 방어막은 다음 자기 턴 시작까지 유지 [임시 규칙]
  if (m.stunned) { m.stunned = false; ts.log.push('T' + ts.round + ' ' + m.name + ' 기절로 행동 불가'); return; }
  const n = DS.actionCount(m); // 민첩성이 높을수록 한 턴에 여러 번 공격할 수 있다
  for (let i = 0; i < n && p.alive; i++) {
    const choice = monsterChoose(G, m, p);
    if (choice) { useSkill(G, ts, m, choice.sid, p); continue; }
    // 사거리에 닿지 않으면 다가간다
    const blocked = new Set(G.dungeon.monsters.filter((o) => o.alive && o !== m).map((o) => o.pos.y * floor.width + o.pos.x));
    blocked.add(p.pos.y * floor.width + p.pos.x);
    const path = DS.findPathAvoiding(floor, m.pos, p.pos, blocked);
    if (path && path.length > 1) m.pos = { x: path[0].x, y: path[0].y };
    break; // 이동하면 그 턴은 끝난다(플레이어와 같은 규칙): 추가 행동은 공격에만 쓰이고, 물러서는 상대를 쫓아와 때리지 못한다
  }
}

// ------------------------------------------------------------ 턴 종료 처리
function unitEndTurn(G, ts, c) {
  const rules = DS.db.rules, st = rules.status;
  for (const sid of Object.keys(c.status)) {
    const e = c.status[sid];
    let dmg = e.stacks * st[sid].damage_per_stack;
    if (sid === 'poison') dmg *= Math.max(st.poison.min_factor, 1 - DS.effStat(c, st.poison.resist_stat) * st.poison.resist_per_point);
    if (c.alive) {
      ts.log.push('T' + ts.round + ' ' + c.name + ' ' + (DS.db.status_names[sid] || sid) + ' 피해 ' + (Math.round(dmg * 10) / 10).toFixed(1));
      c.hp -= dmg;
      if (c.hp <= 0) { c.hp = 0; c.alive = false; ts.log.push('T' + ts.round + ' ' + c.name + ' 쓰러짐'); }
    }
    e.duration -= 1;
    if (e.duration <= 0) delete c.status[sid];
  }
  if (!c.alive) return;
  let heal = c.max_hp * rules.regen.pct_of_max_hp_per_point * Math.max(0, DS.effStat(c, 'regen'));
  if (c.status.bleed) heal *= rules.regen.bleed_heal_factor;
  c.hp = Math.min(c.max_hp, c.hp + heal);
  c.spirit = Math.min(c.max_spirit, c.spirit + rules.spirit_regen_base + DS.effStat(c, 'spirit_regen') * rules.spirit_regen_per_point);
  // 이동·행동 한 번(한 턴)마다 모든 스킬의 재사용 대기가 1 줄어든다.
  for (const sid of Object.keys(c.cooldowns)) c.cooldowns[sid] = Math.max(0, c.cooldowns[sid] - 1);
}

function reapKills(G) {
  const d = G.dungeon;
  for (const m of d.monsters) {
    if (!m.alive && !m.rewarded) {
      m.rewarded = true;
      G.msgs.push(...DS.grantKillRewards(G, m.id));
    }
  }
  d.monsters = d.monsters.filter((m) => m.alive);
}

/** 플레이어가 한 번 행동한 뒤의 세계: 적 행동 → 턴 종료 처리 → 사망·전투 종료 판정. */
DS.worldTick = function (G) {
  const d = G.dungeon, ts = tstate(G), p = G.char.player;
  reapKills(G);
  DS.activateCamps(G);
  const order = d.monsters.filter((m) => m.alive).sort((a, b) => DS.manhattan(a.pos, p.pos) - DS.manhattan(b.pos, p.pos));
  for (const m of order) {
    if (!p.alive) break;
    if (m.alive) monsterTurn(G, ts, m);
  }
  for (const c of [p, ...d.monsters.filter((m) => m.alive)]) unitEndTurn(G, ts, c);
  d.turn += 1;
  reapKills(G);
  // 전투가 끝나면 숙련 보너스(상대 한정)만 푼다. 손상 부위는 마을로 돌아가 회복할 때까지 유지된다(2026-10-14 변경, 4-8).
  if (!DS.alertMonsters(G).length) p.vs_bonus = {};
  flushLog(G, ts);
  if (!p.alive) DS.die(G, ts.instakill);
};

DS.die = function (G, instakill) {
  const d = G.dungeon;
  const killer = d.monsters.filter((m) => m.alive && m.alert).sort((a, b) => DS.manhattan(a.pos, G.char.player.pos) - DS.manhattan(b.pos, G.char.player.pos))[0];
  G.dead = {
    cause: instakill ? '헤드샷 즉사' : '전투 패배', by: killer ? killer.name : '미궁',
    kills: Object.values(G.char.kills).reduce((a, b) => a + b, 0), level: DS.level(G),
    days: Math.floor(d.elapsed_ms / 1000 / DS.db.dungeon.seconds_per_day) + 1, steps: d.steps,
  };
  G.dungeon = null; G.screen = 'dead';
};

// ------------------------------------------------------------ 플레이어 행동 (각각 한 턴)
function playerTurnStart(G) { G.char.player.shield = 0; }

/** 보이는(밝은) 적인가: 시야 반경 안이고 시선이 닿을 때. */
DS.canSee = function (G, m) {
  const floor = DS.getFloor(), p = G.char.player;
  return Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) <= DS.db.dungeon.local_vision + 0.6 && DS.hasLos(floor, p.pos, m.pos);
};

/** 상하좌우로 한 칸 이동(적이 있으면 기본 공격). */
DS.playerMove = function (G, dx, dy) {
  const d = G.dungeon, floor = DS.getFloor(), p = G.char.player;
  if (!d || G.screen !== 'dungeon') return { ok: false };
  const x = p.pos.x + dx, y = p.pos.y + dy;
  const target = DS.monsterAt(G, x, y);
  if (target) return DS.playerAttackDefault(G, target.uid);
  if (!DS.isOpen(floor, x, y)) return { ok: false, reason: 'wall' };
  playerTurnStart(G);
  p.pos = { x, y };
  d.pos = { x, y };
  d.steps += 1;
  const k = y * floor.width + x;
  const vs = DS.visitedSet(G);
  if (!vs.has(k)) { vs.add(k); d.visited.push(k); }
  for (const portal of floor.portals) {
    if (portal.x === x && portal.y === y) {
      const msgs = DS.discoverPortal(G, portal.id);
      if (msgs) G.msgs.push(...msgs, '2층은 아직 준비 중입니다.');
    }
  }
  DS.worldTick(G);
  return { ok: true, moved: true };
};

DS.playerWait = function (G) {
  if (!G.dungeon) return { ok: false };
  playerTurnStart(G);
  tstate(G).log.push('T' + G.dungeon.turn + ' ' + G.char.player.name + ' 대기');
  DS.worldTick(G);
  return { ok: true };
};

DS.canUseSkill = function (G, sid, target) {
  const p = G.char.player, s = DS.db.skills[sid], floor = DS.getFloor();
  if (!p.skills.includes(sid)) return { ok: false, reason: '없는 스킬' };
  if ((p.cooldowns[sid] || 0) > 0) return { ok: false, reason: '쿨타임 ' + p.cooldowns[sid] + '턴' };
  if (p.spirit < s.cost) return { ok: false, reason: '영혼력 부족' };
  if (s.kind === 'defend') return { ok: true };
  if (!target || !target.alive) return { ok: false, reason: '대상 없음' };
  if (!DS.inRange(floor, p.pos, target.pos, DS.skillRange(p, sid))) return { ok: false, reason: '사거리 밖' };
  return { ok: true };
};

DS.playerSkill = function (G, sid, uid) {
  if (!G.dungeon || G.screen !== 'dungeon') return { ok: false };
  const target = uid ? G.dungeon.monsters.find((m) => m.uid === uid) : null;
  const chk = DS.canUseSkill(G, sid, target);
  if (!chk.ok) return chk;
  const ts = tstate(G);
  playerTurnStart(G);
  if (target) target.alert = true; // 공격을 받으면 멀리서도 반격하러 온다
  // 방어는 자기 턴 시작에 사라지므로 사용 직후 새로 쌓는다
  useSkill(G, ts, G.char.player, sid, target);
  DS.worldTick(G);
  return { ok: true };
};

/** 기본 공격: 지금 쓸 수 있는 가장 약한(싼) 공격 스킬 — 우선 베기. */
DS.playerAttackDefault = function (G, uid) {
  const p = G.char.player;
  const target = G.dungeon.monsters.find((m) => m.uid === uid);
  const order = ['slash'].concat(p.skills.filter((s) => s !== 'slash' && DS.db.skills[s].kind === 'attack'));
  for (const sid of order) if (p.skills.includes(sid) && DS.canUseSkill(G, sid, target).ok) return DS.playerSkill(G, sid, uid);
  return DS.canUseSkill(G, 'slash', target);
};
