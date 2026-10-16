// 지도 위 무리 전투 시뮬레이션: 실제 진영 자리에 무리를 세우고, 7칸 떨어진 곳에서 접근해 기본 공격(적 탭)으로 싸운다.
// 사용: node web/tests/groupsim.js <몬스터id> [무리크기...]   예) node web/tests/groupsim.js goblin 1 3 4
const DS = require('./load');
// 실제 진영 자리에 무리를 세우고, 플레이어가 7칸 떨어진 곳에서 접근해 싸우는 시나리오.
function run(seed, weapon, id, n) {
  const G = DS.newGame(seed); DS.createChar(G, weapon); DS.enterDungeon(G);
  const f = DS.getFloor(), p = G.char.player, d = G.dungeon;
  const camps = d.camps.filter((c) => c.zone !== 'center'); const camp = camps[seed % camps.length];
  d.monsters = []; d.camps.forEach((c) => { c.state = 'active'; });
  // 무리: 진영 중심 2칸 안
  const occ = new Set(); let k = 0;
  for (let dy = -2; dy <= 2 && k < n; dy++) for (let dx = -2; dx <= 2 && k < n; dx++) {
    const x = camp.x + dx, y = camp.y + dy; if (!DS.isOpen(f, x, y) || Math.hypot(dx, dy) > 2) continue;
    const m = DS.makeMonster(id); m.uid = 'm' + k; m.alert = false; m.alert_turns = 0; m.pos = { x, y }; d.monsters.push(m); k++;
  }
  if (k < n) return null;
  // 플레이어: 진영에서 BFS 7칸 떨어진 칸
  const far = []; const seen = new Map([[camp.y * f.width + camp.x, 0]]); const q = [{ x: camp.x, y: camp.y }];
  for (let i = 0; i < q.length; i++) { const c = q[i], dd = seen.get(c.y * f.width + c.x); if (dd === 7) far.push(c); if (dd >= 7) continue; for (const [dx, dy] of DS.DIRS) { const x = c.x + dx, y = c.y + dy, kk = y * f.width + x; if (DS.isOpen(f, x, y) && !seen.has(kk)) { seen.set(kk, dd + 1); q.push({ x, y }); } } }
  if (!far.length) return null;
  p.pos = { ...far[seed % far.length] }; d.pos = { ...p.pos };
  let t = 0;
  while (G.screen === 'dungeon' && d.monsters.length && t++ < 300) {
    const near = d.monsters.slice().sort((a, b) => DS.manhattan(a.pos, p.pos) - DS.manhattan(b.pos, p.pos));
    const tgt = near.find((m) => DS.canUseSkill(G, 'slash', m).ok) || null;
    if (tgt) { const r = DS.playerAttackDefault(G, tgt.uid); if (!r.ok) DS.playerWait(G); }
    else if (d.monsters.some((m) => m.alert)) DS.playerWait(G);
    else { const path = DS.findPath(f, p.pos, near[0].pos); if (path && path.length > 1) DS.playerMove(G, path[0].x - p.pos.x, path[0].y - p.pos.y); else DS.playerWait(G); }
  }
  const win = G.screen === 'dungeon' && !d.monsters.length;
  return { win, hp: win ? p.hp : 0 };
}
module.exports = { run, DS };
if (require.main === module) {
  const [id, ...rest] = process.argv.slice(2); const sizes = rest.length ? rest.map(Number) : [1, 2, 3, 4];
  const W = ['spear', 'sword', 'mace', 'shield', 'greatsword', 'bow'];
  console.log(['무기', ...sizes.map((n) => id + '×' + n)].join('\t'));
  for (const w of W) { const row = [DS.db.equipment.weapons[w].name_ko]; for (const n of sizes) { let wins = 0, hp = 0, tot = 0; for (let i = 1; i <= 600; i++) { const r = run(i, w, id, n); if (!r) continue; tot++; if (r.win) { wins++; hp += r.hp; } } row.push((wins / tot * 100).toFixed(0) + '%/' + (wins ? Math.round(hp / wins) : 0)); } console.log(row.join('\t')); }
}
