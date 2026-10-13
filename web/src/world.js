/* 미궁 1층: 고정 지형 생성, 구역, 이동·조우, 드랍, 경험치. 모든 수치는 DS.db.dungeon / economy / progression. */
const DS = (globalThis.DS = globalThis.DS || {});

// ------------------------------------------------------------ 지형 (셀룰러 오토마타, 시드 고정)
function generateCave(cfg, seed) {
  const W = cfg.width, H = cfg.height;
  for (let attempt = 0; attempt < 50; attempt++) {
    const rng = DS.newRng(seed + attempt);
    let g = [];
    for (let y = 0; y < H; y++) {
      g.push([]);
      for (let x = 0; x < W; x++) {
        const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1;
        g[y].push(edge ? 1 : DS.rand(rng) < cfg.fill ? 1 : 0); // 1 = 벽
      }
    }
    for (let pass = 0; pass < cfg.smooth_passes; pass++) {
      const n = g.map((r) => r.slice());
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          let walls = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) walls += g[y + dy][x + dx];
          n[y][x] = walls >= 5 ? 1 : 0;
        }
      }
      g = n;
    }
    const cx = Math.floor(W / 2), cy = Math.floor(H / 2);
    // 중심 근처의 열린 칸을 찾아 그 연결 성분만 남긴다(모든 칸이 중심에서 도달 가능).
    let start = null;
    for (let r = 0; r < 8 && !start; r++) {
      for (let dy = -r; dy <= r && !start; dy++) for (let dx = -r; dx <= r; dx++) {
        if (g[cy + dy] && g[cy + dy][cx + dx] === 0) { start = { x: cx + dx, y: cy + dy }; break; }
      }
    }
    if (!start) continue;
    const seen = floodFill(g, start);
    if (seen.size < cfg.min_open_tiles) continue;
    const grid = g.map((row, y) => row.map((v, x) => (v === 0 && seen.has(y * W + x) ? 0 : 1)));
    return { grid, start, seedUsed: seed + attempt };
  }
  throw new Error('cave generation failed');
}

function floodFill(g, start) {
  const W = g[0].length;
  const seen = new Set([start.y * W + start.x]);
  const q = [start];
  while (q.length) {
    const c = q.pop();
    for (const [dx, dy] of DS.DIRS) {
      const x = c.x + dx, y = c.y + dy;
      if (g[y] && g[y][x] === 0 && !seen.has(y * W + x)) { seen.add(y * W + x); q.push({ x, y }); }
    }
  }
  return seen;
}

DS.DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // 4방향 이동만(대각선 없음)

/** 고정 세계. 같은 world_seed 면 항상 같은 결과. */
DS.buildFloor1 = function () {
  const cfg = DS.db.dungeon.floor1;
  const cave = generateCave(cfg, DS.db.dungeon.world_seed);
  const grid = cave.grid, start = cave.start;
  const open = [];
  grid.forEach((row, y) => row.forEach((v, x) => { if (v === 0) open.push({ x, y }); }));
  // 포탈: 동서남북 끝의 열린 칸
  const pick = (cmp) => open.reduce((a, b) => (cmp(b, a) ? b : a));
  const portals = [
    { id: 'north', ...pick((b, a) => b.y < a.y) },
    { id: 'east', ...pick((b, a) => b.x > a.x) },
    { id: 'south', ...pick((b, a) => b.y > a.y) },
    { id: 'west', ...pick((b, a) => b.x < a.x) },
  ];
  return { width: grid[0].length, height: grid.length, grid, start, portals, cfg };
};

/** 구역: 중심 반경 안은 중심부, 밖은 시작점 기준 가장 큰 축 방향(북/동/남/서). */
DS.zoneAt = function (floor, x, y) {
  const dx = x - floor.start.x, dy = y - floor.start.y;
  if (Math.hypot(dx, dy) <= floor.cfg.center_radius) return 'center';
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'east' : 'west';
  return dy > 0 ? 'south' : 'north';
};

DS.isOpen = function (floor, x, y) {
  return !!(floor.grid[y] && floor.grid[y][x] === 0);
};

/** BFS 최단 경로(탭 이동용). 도달 불가면 null. */
DS.findPath = function (floor, from, to) {
  if (!DS.isOpen(floor, to.x, to.y)) return null;
  const W = floor.width;
  const prev = new Map([[from.y * W + from.x, null]]);
  const q = [from];
  for (let i = 0; i < q.length; i++) {
    const c = q[i];
    if (c.x === to.x && c.y === to.y) break;
    for (const [dx, dy] of DS.DIRS) {
      const x = c.x + dx, y = c.y + dy, k = y * W + x;
      if (DS.isOpen(floor, x, y) && !prev.has(k)) { prev.set(k, c); q.push({ x, y }); }
    }
  }
  const tk = to.y * W + to.x;
  if (!prev.has(tk)) return null;
  const path = [];
  for (let c = to; c && !(c.x === from.x && c.y === from.y); c = prev.get(c.y * W + c.x)) path.push({ x: c.x, y: c.y });
  return path.reverse();
};

// ------------------------------------------------------------ 조우
DS.monstersInZone = function (zone) {
  const all = Object.entries(DS.db.monsters).filter(([, m]) => m.floor === 1);
  return all.filter(([, m]) => zone === 'center' || m.zone === zone).map(([id]) => id);
};

// ------------------------------------------------------------ 보상
DS.expToLevel = function (exp) {
  const t = DS.db.progression.exp_to_level;
  let lv = 1;
  for (let i = 1; i < t.length; i++) if (exp >= t[i]) lv = i + 1;
  return lv;
};

DS.masteryLevel = function (kills, monsterId) {
  const m = DS.db.rules.mastery;
  return Math.min(m.max_level, Math.floor((kills[monsterId] || 0) / m.kills_per_level));
};

/** 처치 보상: 첫 처치 경험치, 마석(확률), 숙련 누적. 반환값은 UI 에 보여줄 메시지 배열. */
DS.grantKillRewards = function (G, monsterId) {
  const msgs = [];
  const m = DS.db.monsters[monsterId];
  const c = G.char;
  const first = !(c.kills[monsterId] > 0);
  const prevMastery = DS.masteryLevel(c.kills, monsterId);
  c.kills[monsterId] = (c.kills[monsterId] || 0) + 1;
  if (first) {
    const gain = DS.db.progression.exp_by_grade[m.grade];
    msgs.push(m.name_ko + ' 첫 처치! 경험치 +' + gain);
    gainExp(G, gain, msgs);
  }
  const mastery = DS.masteryLevel(c.kills, monsterId);
  if (mastery > prevMastery) msgs.push(m.name_ko + ' 숙련 ' + mastery + '단계!');
  if (DS.rand(G.rng) < DS.db.economy.maseok_drop_chance) {
    c.items['maseok_' + m.grade] = (c.items['maseok_' + m.grade] || 0) + 1;
    msgs.push(m.grade + '등급 마석 +1');
  }
  return msgs;
};

function gainExp(G, gain, msgs) {
  const c = G.char;
  const before = DS.expToLevel(c.exp);
  c.exp += gain;
  const after = DS.expToLevel(c.exp);
  if (after > before) msgs.push('레벨 ' + after + '! 정수 슬롯 ' + (after - before) + '개 열림');
}

DS.discoverPortal = function (G, portalId) {
  const c = G.char;
  if (c.portals.includes(portalId)) return null;
  c.portals.push(portalId);
  const msgs = ['포탈 발견! 경험치 +' + DS.db.progression.portal_exp];
  gainExp(G, DS.db.progression.portal_exp, msgs);
  return msgs;
};

DS.exchangeAll = function (G) {
  const c = G.char;
  let total = 0;
  for (const key of Object.keys(c.items)) {
    if (!key.startsWith('maseok_')) continue;
    const grade = key.split('_')[1];
    total += c.items[key] * DS.db.economy.exchange_rate_by_grade[grade];
    delete c.items[key];
  }
  c.stones += total;
  return total;
};
