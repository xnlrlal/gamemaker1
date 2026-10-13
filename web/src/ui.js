/* DOM·캔버스 UI. 게임 규칙은 game.js / combat.js / world.js 에만 있고, 여기서는 상태를 그리고 입력을 전달만 한다. */
(function () {
  const DS = globalThis.DS;
  let G = null;
  let toastsEl, screenEl, hudEl;
  const ui = { weapon: 'greatsword', confirmReset: false, mapMode: 'local', walk: [], held: null, stepT: 0,
    prev: null, alpha: 1, predict: null, autoT: 0, saveT: 0, lastBattleLogLen: 0, log: [], hitFlash: null };

  // ---------------------------------------------------------- 유틸
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const k in attrs || {}) {
      const v = attrs[k];
      if (v === false || v === null || v === undefined) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'checked' || k === 'disabled') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const storage = () => { try { return window.localStorage; } catch (e) { return null; } };
  function save(force) {
    const s = storage();
    if (!s || !G) return;
    const now = Date.now();
    if (!force && now - ui.saveT < 1000) return;
    ui.saveT = now;
    DS.saveToStorage(G, s);
  }
  const fmt = (x) => Math.round(x);
  const nameOfStat = (k) => DS.db.stat_names[k] || k;
  const bonusText = (b) => Object.entries(b).map(([k, v]) => nameOfStat(k) + (v > 0 ? '+' : '') + v).join(' · ') || '—';

  function bar(kind, value, max, label) {
    const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
    const i = h('i'); i.style.width = pct + '%';
    return h('div', { class: 'bar ' + kind, role: 'progressbar', 'aria-valuenow': fmt(value), 'aria-valuemax': fmt(max) }, i,
      h('span', {}, (label ? label + ' ' : '') + fmt(value) + '/' + fmt(max)));
  }

  function flushMsgs() {
    if (!G.msgs.length) return;
    for (const m of G.msgs.splice(0)) {
      ui.log.unshift(m);
      const t = h('div', { class: 'toast', role: 'status' }, m);
      toastsEl.append(t);
      setTimeout(() => t.remove(), 3000);
      while (toastsEl.children.length > 2) toastsEl.firstChild.remove();
    }
    ui.log = ui.log.slice(0, 40);
  }

  // ---------------------------------------------------------- HUD
  function renderHud() {
    hudEl.replaceChildren();
    if (!G.char || G.screen === 'create' || G.screen === 'dead') { hudEl.hidden = true; return; }
    hudEl.hidden = false;
    const lv = DS.level(G);
    hudEl.append(
      h('span', {}, '레벨 ', h('b', { class: 'num' }, lv)),
      h('span', {}, '스톤 ', h('b', { class: 'num' }, G.char.stones)),
      h('span', { class: 'sp' }),
      G.dungeon ? h('span', { id: 'clock', class: 'num' }, clockText()) : h('span', { class: 'muted num' }, '마을 ' + G.town.day + '일째'),
    );
  }
  function clockText() {
    const d = DS.dungeonDays(G), max = DS.db.dungeon.floor1.forced_return_days;
    const day = Math.min(max, Math.floor(d) + 1);
    return '미궁 ' + day + '일째 · 귀환까지 ' + Math.max(0, Math.ceil((max - d) * DS.db.dungeon.seconds_per_day)) + '초';
  }

  // ---------------------------------------------------------- 화면: 캐릭터 생성
  function screenCreate() {
    const weapons = DS.db.equipment.weapons;
    const hasSave = !!(storage() && storage().getItem(DS.SAVE_KEY));
    return [
      h('div', { class: 'hero' },
        h('span', { class: 'tag' }, '프로토타입 v0'),
        h('h1', {}, '던전 앤 스톤'),
        h('p', { class: 'muted' }, '이 게임을 해 본 사람이 그 세계에 떨어졌다. 아는 것이 힘이지만, 아는 것과 살아남는 것은 다르다. 한 번 죽으면 모든 것을 잃는다.')),
      h('div', { class: 'card' },
        h('h2', {}, '바바리안 성인식'),
        h('p', { class: 'muted small' }, '무기 6종 중 하나를 고릅니다. 천 상의·천 하의·샌들이 자동 지급됩니다.'),
        h('div', { class: 'weapons' }, Object.entries(weapons).map(([id, w]) =>
          h('button', { class: 'weapon', 'aria-pressed': ui.weapon === id, onclick: () => { ui.weapon = id; render(); } },
            h('b', {}, w.name_ko), h('span', {}, bonusText(w.bonuses))))),
        h('button', { class: 'btn primary', onclick: () => { DS.createChar(G, ui.weapon); ui.walk = []; save(true); render(); } }, '성인식 시작')),
      h('p', { class: 'muted small' }, '수치는 모두 임시값입니다. 진행은 이 기기에 자동 저장되고, 사망하면 처음부터 다시 시작합니다.'),
    ];
  }

  // ---------------------------------------------------------- 화면: 마을
  function screenTown() {
    const c = G.char, p = c.player;
    const lv = DS.level(G);
    const t = DS.db.progression.exp_to_level;
    const nextExp = lv < t.length ? t[lv] : c.exp;
    const baseExp = t[lv - 1];
    const stat = (k) => [k, DS.effStat(p, k)];
    const maseok = Object.entries(c.items).filter(([k]) => k.startsWith('maseok_'));
    return [
      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('h2', { class: 'grow' }, '라프도니아 성채'), h('span', { class: 'chip' }, '정수 슬롯 ' + lv)),
        bar('hp', p.hp, p.max_hp, '생명력'),
        bar('xp', c.exp - baseExp, Math.max(1, nextExp - baseExp), '경험치'),
        h('div', { class: 'stats' }, ['strength', 'phys_res', 'regen', 'accuracy', 'flexibility', 'agility'].map(stat).map(([k, v]) =>
          h('div', { class: 'stat' }, h('small', {}, nameOfStat(k)), h('b', {}, v)))),
        h('p', { class: 'small muted' }, '최대 영혼력 ' + fmt(p.max_spirit) + ' · 정수는 아직 준비 중입니다.')),
      h('div', { class: 'card' },
        h('h3', {}, '장비'),
        h('div', { class: 'list' }, p.gear.map((g) =>
          h('div', { class: 'item' },
            h('span', {}, g.name + (g.durability === 0 ? ' (파손)' : '')),
            h('span', { class: 'muted num' }, bonusText(g.bonuses) + (g.durability !== null ? ' · 내구 ' + g.durability + '/' + g.max_durability : '')))))),
      h('div', { class: 'card' },
        h('h3', {}, '마석'),
        maseok.length ? h('div', { class: 'list' }, maseok.map(([k, n]) => h('div', { class: 'item' }, h('span', {}, k.split('_')[1] + '등급 마석'), h('span', { class: 'num' }, '×' + n))))
          : h('p', { class: 'muted small' }, '아직 없습니다. 미궁에서 몬스터를 쓰러뜨리면 얻습니다.'),
        h('button', { class: 'btn', disabled: !c.returned_once || !maseok.length, onclick: () => {
          const total = DS.exchange(G);
          G.msgs.push('환전소: 스톤 +' + total);
          save(true); render();
        } }, c.returned_once ? '환전소에서 전부 바꾸기' : '환전소 (첫 미궁 귀환 후 열림)')),
      h('div', { class: 'card' },
        h('p', { class: 'small muted' }, '미궁은 정해진 주기에만 열립니다. 다음 판단 시점까지 건너뛰면 입장 여부를 묻는 판단창이 뜹니다. 미궁 안에서는 스스로 돌아올 수 없고, 정해진 체류일이 지나면 강제로 귀환합니다.'),
        h('button', { class: 'btn primary', onclick: () => { DS.townSkip(G); save(true); render(); } }, '다음 판단 시점까지 건너뛰기')),
      ui.log.length ? h('div', { class: 'card' }, h('h3', {}, '기록'), h('div', { class: 'log' }, ui.log.slice(0, 12).map((m) => h('div', {}, m)))) : null,
      h('div', { class: 'row wrap' },
        ui.confirmReset
          ? [h('span', { class: 'small muted grow' }, '정말 처음부터 시작할까요?'),
             h('button', { class: 'btn danger', onclick: () => { DS.clearSave(storage()); G = DS.newGame(Date.now()); ui.confirmReset = false; ui.log = []; render(); } }, '삭제하고 새 게임'),
             h('button', { class: 'btn', onclick: () => { ui.confirmReset = false; render(); } }, '취소')]
          : h('button', { class: 'btn', onclick: () => { ui.confirmReset = true; render(); } }, '저장 삭제 / 새 게임')),
    ];
  }

  // ---------------------------------------------------------- 화면: 판단창
  function screenJudgment() {
    return [h('div', { class: 'card judgment' },
      h('h2', {}, '미궁에 들어가시겠습니까?'),
      h('div', { class: 'countdown', id: 'judg-cd' }, Math.ceil(G.judgment.remaining_ms / 1000)),
      h('p', { class: 'muted small' }, '무응답은 거부입니다. 거부해도 불이익은 없고 다음 주기를 기다립니다.'),
      h('div', { class: 'row', style: 'width:100%' },
        h('button', { class: 'btn grow', onclick: () => { DS.declineJudgment(G); save(true); render(); } }, '거부'),
        h('button', { class: 'btn primary grow', onclick: () => { DS.enterDungeon(G); ui.walk = []; ui.prev = null; save(true); render(); } }, '입장')))];
  }

  // ---------------------------------------------------------- 화면: 미궁
  function screenDungeon() {
    const p = G.char.player;
    const canvas = h('canvas', { id: 'map', width: 480, height: 480, 'aria-label': '미궁 지도. 탭하면 그 칸으로 이동합니다.' });
    canvas.addEventListener('pointerdown', onMapTap);
    const dir = (name, label, dx, dy) => {
      const b = h('button', { class: name, 'aria-label': label }, label === '위' ? '▲' : label === '아래' ? '▼' : label === '왼쪽' ? '◀' : '▶');
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); ui.walk = []; ui.held = [dx, dy]; });
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => { ui.held = null; });
      return b;
    };
    return [
      h('div', { class: 'mapwrap' }, canvas,
        h('div', { class: 'maptop' },
          h('span', { class: 'pill', id: 'zone' }, zoneLabel()),
          h('button', { class: 'pill', onclick: () => { ui.mapMode = ui.mapMode === 'local' ? 'full' : 'local'; render(); } }, ui.mapMode === 'local' ? '전체맵' : '로컬맵'))),
      bar('hp', p.hp, p.max_hp, '생명력'),
      h('div', { class: 'dpad' }, dir('up', '위', 0, -1), dir('left', '왼쪽', -1, 0), dir('down', '아래', 0, 1), dir('right', '오른쪽', 1, 0)),
      h('p', { class: 'small muted' }, '지도를 탭하면 그 칸까지 걸어갑니다. 걷다 보면 몬스터와 마주칩니다. 가본 곳만 지도에 남습니다.'),
    ];
  }
  function zoneLabel() {
    const floor = DS.getFloor();
    const z = DS.zoneAt(floor, G.dungeon.pos.x, G.dungeon.pos.y);
    return '1층 ' + DS.db.dungeon.floor1.name + ' · ' + DS.db.zone_names[z];
  }

  function tileSize() { return ui.mapMode === 'local' ? 40 : 12; }

  function onMapTap(e) {
    if (G.screen !== 'dungeon') return;
    const cv = e.currentTarget, r = cv.getBoundingClientRect();
    const scale = cv.width / r.width, ts = tileSize();
    const px = (e.clientX - r.left) * scale, py = (e.clientY - r.top) * scale;
    const pos = G.dungeon.pos;
    const tx = Math.round(pos.x + (px - cv.width / 2) / ts), ty = Math.round(pos.y + (py - cv.height / 2) / ts);
    const path = DS.findPath(DS.getFloor(), pos, { x: tx, y: ty });
    // 가보지 않은 칸은 지도에 보이지 않으므로, 보이는(가본 곳 + 인접) 칸만 목적지로 허용한다.
    if (path && path.length && visible(tx, ty)) { ui.walk = path; ui.held = null; }
  }

  /** 지도에 보이는 칸. 로컬맵은 주변 반경 안, 전체맵은 가본 칸(과 그 벽)만. 안 가본 먼 칸은 흐린 표시조차 하지 않는다(7-1). */
  function visible(x, y) {
    const floor = DS.getFloor(), vs = DS.visitedSet(G);
    if (ui.mapMode === 'local') {
      const p = G.dungeon.pos;
      if (Math.hypot(x - p.x, y - p.y) <= DS.db.dungeon.local_vision) return true;
    }
    if (vs.has(y * floor.width + x)) return true;
    for (const [dx, dy] of DS.DIRS) if (vs.has((y + dy) * floor.width + (x + dx))) return true;
    return false;
  }

  function drawMap() {
    const cv = document.getElementById('map');
    if (!cv || !G.dungeon) return;
    const ctx = cv.getContext('2d'), floor = DS.getFloor(), ts = tileSize();
    const css = getComputedStyle(document.documentElement);
    const col = (n) => css.getPropertyValue(n).trim();
    ctx.fillStyle = col('--bg'); ctx.fillRect(0, 0, cv.width, cv.height);
    const pos = G.dungeon.pos, prev = ui.prev || pos;
    const cx = prev.x + (pos.x - prev.x) * ui.alpha, cy = prev.y + (pos.y - prev.y) * ui.alpha;
    const half = Math.ceil(cv.width / ts / 2) + 1;
    const vs = DS.visitedSet(G);
    for (let y = Math.floor(cy) - half; y <= Math.ceil(cy) + half; y++) {
      for (let x = Math.floor(cx) - half; x <= Math.ceil(cx) + half; x++) {
        if (x < 0 || y < 0 || x >= floor.width || y >= floor.height || !visible(x, y)) continue;
        const sx = cv.width / 2 + (x - cx) * ts - ts / 2, sy = cv.height / 2 + (y - cy) * ts - ts / 2;
        const open = floor.grid[y][x] === 0;
        ctx.fillStyle = open ? (vs.has(y * floor.width + x) ? col('--tile-floor') : col('--tile-seen')) : col('--tile-wall');
        ctx.fillRect(sx, sy, ts + 0.5, ts + 0.5);
        if (!open && ts > 20) { ctx.strokeStyle = col('--line'); ctx.strokeRect(sx + 0.5, sy + 0.5, ts - 1, ts - 1); }
      }
    }
    for (const portal of floor.portals) {
      if (!visible(portal.x, portal.y)) continue;
      const sx = cv.width / 2 + (portal.x - cx) * ts, sy = cv.height / 2 + (portal.y - cy) * ts;
      const found = G.char.portals.includes(portal.id);
      ctx.fillStyle = found ? col('--good') : col('--shield');
      ctx.beginPath(); ctx.arc(sx, sy, Math.max(3, ts * 0.32), 0, Math.PI * 2); ctx.fill();
    }
    // 현재 위치는 항상 화면 정중앙(7-1 지도 원칙: 절대 좌표로 위치를 유추하지 못하게)
    ctx.fillStyle = col('--accent');
    ctx.beginPath(); ctx.arc(cv.width / 2, cv.height / 2, Math.max(4, ts * 0.34), 0, Math.PI * 2); ctx.fill();
  }

  // ---------------------------------------------------------- 화면: 전투
  function battleKey() { const g = G.dungeon.group; return g.enemies.join(',') + ':' + g.index + ':' + G.battle.rng.s; }

  function statusChips(c) {
    const chips = [];
    for (const [sid, e] of Object.entries(c.status)) chips.push(h('span', { class: 'chip bad' }, (DS.db.status_names[sid] || sid) + ' ×' + e.stacks + ' · ' + e.duration + '턴'));
    if (c.stunned) chips.push(h('span', { class: 'chip bad' }, '기절'));
    for (const part of c.damaged_parts) chips.push(h('span', { class: 'chip warn' }, DS.db.part_names[part] + ' 손상'));
    return chips;
  }

  function fighterCard(c, flash) {
    return h('div', { class: 'card fighter' + (flash ? ' hit' : '') },
      h('div', { class: 'name' }, h('h3', {}, c.name), c.grade ? h('span', { class: 'small muted' }, c.grade + '등급' + (c.ranged ? ' · 원거리' : '')) : null),
      bar('hp', c.hp, c.max_hp, '생명력'),
      c.is_player ? bar('sp', c.spirit, c.max_spirit, '영혼력') : null,
      c.shield > 0 ? bar('sh thin', c.shield, 40, '방어막') : null,
      statusChips(c).length ? h('div', { class: 'chips' }, statusChips(c)) : null);
  }

  function skillButton(sid) {
    const st = G.battle, p = st.allies[0], s = DS.db.skills[sid];
    const cd = p.cooldowns[sid] || 0;
    const usable = DS.skillUsable(st, p, sid);
    const val = s.kind === 'attack' ? '위력 ' + fmt(DS.skillValue(st, p, sid)) : '방어막 ' + fmt(DS.skillValue(st, p, sid));
    const extra = (s.on_hit || []).map((e) => (DS.db.status_names[e.status] || e.status) + (e.chance ? ' ' + Math.round(e.chance * 100) + '%' : '')).join(' ');
    const reason = cd > 0 ? '쿨타임 ' + cd : p.spirit < s.cost ? '영혼력 부족' : '사용 가능';
    return h('button', { class: 'skill', disabled: !usable || G.auto, onclick: () => act(sid) },
      h('b', {}, s.name_ko),
      h('span', { class: 'state' }, reason),
      h('span', { class: 'meta' }, [val, '영혼력 ' + s.cost, '쿨 ' + s.cooldown, extra].filter(Boolean).join(' · ')));
  }

  function screenBattle() {
    const st = G.battle, g = G.dungeon.group, p = st.allies[0];
    const key = battleKey();
    if (!ui.predict || ui.predict.key !== key) ui.predict = { key, p: DS.estimateWinRate(st, 200) };
    const warn = ui.predict.p < DS.db.dungeon.auto_warn_win_rate;
    const newFrom = ui.lastBattleLogLen;
    const lines = st.log.slice(-8);
    const flashEnemy = st.last && st.last.kind === 'hit' && st.last.target === st.enemy.id;
    const flashPlayer = st.last && st.last.kind === 'hit' && st.last.target === p.id;
    const total = Math.max(1, g.enemies.length);
    return [
      h('div', { class: 'row' },
        h('span', { class: 'chip' }, '무리 ' + (g.index + 1) + '/' + total),
        h('span', { class: 'chip num' }, st.round === 0 ? '전투 시작' : st.round + '라운드'),
        h('span', { class: 'grow' }),
        h('span', { class: 'chip ' + (warn ? 'warn' : 'good') }, '예상 승률 ' + Math.round(ui.predict.p * 100) + '%')),
      fighterCard(st.enemy, flashEnemy),
      fighterCard(p, flashPlayer),
      warn ? h('p', { class: 'small', style: 'color:var(--warn)' }, '위험할 수 있습니다. 예상 승률이 낮습니다.') : null,
      h('div', { class: 'battlelog', id: 'blog' }, lines.length
        ? lines.map((l, i) => h('div', { class: (st.log.length - lines.length + i) >= newFrom ? 'new' : '' }, l))
        : h('div', {}, '스킬을 골라 전투를 시작하세요.')),
      h('label', { class: 'auto card', style: 'flex-direction:row;align-items:center' },
        h('input', { type: 'checkbox', class: 'switch', id: 'auto-sw', checked: G.auto, onchange: (e) => { G.auto = e.target.checked; render(); } }),
        h('span', { class: 'grow' }, '자동 전투'),
        h('span', { class: 'small muted' }, G.auto ? '끄면 수동으로 전환' : '켜 두면 다음 전투에도 이어짐')),
      h('div', { class: 'skills' }, p.skills.map(skillButton)),
    ];
  }

  function act(sid) {
    if (G.screen !== 'battle') return;
    ui.lastBattleLogLen = G.battle.log.length;
    const r = DS.battleAct(G, sid);
    afterAct(r);
  }

  function afterAct(r) {
    save(true);
    if (r === 'defeat') G.auto = false;
    if (r === 'next') ui.lastBattleLogLen = 0;
    render();
    const bl = document.getElementById('blog');
    if (bl) bl.scrollTop = bl.scrollHeight;
  }

  // ---------------------------------------------------------- 화면: 사망
  function screenDead() {
    const d = G.dead;
    return [h('div', { class: 'card', style: 'border-color:var(--bad)' },
      h('h1', { style: 'color:var(--bad)' }, '사망'),
      h('p', {}, d.by + '에게 ' + d.cause + '. 캐릭터와 모든 진행이 사라졌습니다.'),
      h('div', { class: 'list' },
        h('div', { class: 'item' }, h('span', {}, '도달 레벨'), h('span', { class: 'num' }, d.level)),
        h('div', { class: 'item' }, h('span', {}, '처치 수'), h('span', { class: 'num' }, d.kills)),
        h('div', { class: 'item' }, h('span', {}, '미궁 체류'), h('span', { class: 'num' }, d.days + '일째 · ' + d.steps + '걸음'))),
      h('button', { class: 'btn primary', onclick: () => { DS.afterDeathNewChar(G); DS.clearSave(storage()); ui.log = []; render(); } }, '새 캐릭터 만들기'))];
  }

  // ---------------------------------------------------------- 렌더 루프
  function render() {
    flushMsgs();
    renderHud();
    const map = { create: screenCreate, town: screenTown, judgment: screenJudgment, dungeon: screenDungeon, battle: screenBattle, dead: screenDead };
    const scrollTop = screenEl.scrollTop;
    screenEl.replaceChildren(...map[G.screen]().filter(Boolean));
    screenEl.scrollTop = G.screen === 'battle' || G.screen === 'dungeon' ? scrollTop : 0;
    ui.skipDraw = false;
    if (G.screen === 'dungeon') drawMap();
    window.__G = G; // 테스트·디버깅용
    DS.uiRender = render;
  }

  function stepWalk(dt) {
    if (G.screen !== 'dungeon') { ui.walk = []; return; }
    const speed = DS.db.dungeon.move_tiles_per_second;
    ui.stepT += dt;
    ui.alpha = Math.min(1, ui.alpha + dt * speed);
    if (ui.stepT < 1 / speed) return;
    let target = null;
    if (ui.walk.length) target = ui.walk[0];
    else if (ui.held) target = { x: G.dungeon.pos.x + ui.held[0], y: G.dungeon.pos.y + ui.held[1] };
    if (!target) { ui.stepT = 0; return; }
    ui.stepT = 0;
    const from = { x: G.dungeon.pos.x, y: G.dungeon.pos.y };
    if (DS.stepTo(G, target.x, target.y)) {
      ui.prev = from; ui.alpha = 0;
      if (ui.walk.length) ui.walk.shift();
      if (G.screen !== 'dungeon') { ui.walk = []; ui.held = null; ui.predict = null; ui.lastBattleLogLen = 0; render(); save(true); return; }
      flushMsgs();
      const z = document.getElementById('zone'); if (z) z.textContent = zoneLabel();
      save(false);
    } else ui.walk = [];
  }

  let last = performance.now(), clockAcc = 0;
  function frame(now) {
    const dt = Math.min(0.25, (now - last) / 1000); last = now;
    if (!document.hidden) {
      // 판단창 카운트다운
      if (G.screen === 'judgment') {
        G.judgment.remaining_ms -= dt * 1000;
        const cd = document.getElementById('judg-cd');
        if (cd) cd.textContent = Math.max(0, Math.ceil(G.judgment.remaining_ms / 1000));
        if (G.judgment.remaining_ms <= 0) { DS.declineJudgment(G); save(true); render(); }
      }
      // 미궁 시계(전투 중에도 흐른다)
      if (G.dungeon && (G.screen === 'dungeon' || G.screen === 'battle')) {
        if (DS.tickClock(G, dt * 1000)) { ui.walk = []; ui.held = null; G.auto = false; save(true); render(); }
        else {
          clockAcc += dt;
          if (clockAcc > 0.25) { clockAcc = 0; const c = document.getElementById('clock'); if (c) c.textContent = clockText(); }
        }
      }
      stepWalk(dt);
      if (G.screen === 'dungeon') drawMap();
      // 자동 전투
      if (G.auto && G.screen === 'battle') {
        ui.autoT += dt;
        if (ui.autoT > 0.7) { ui.autoT = 0; ui.lastBattleLogLen = G.battle.log.length; afterAct(DS.battleAct(G, null)); }
      }
    }
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------- 시작
  function onKey(e) {
    const m = { ArrowUp: [0, -1], w: [0, -1], ArrowDown: [0, 1], s: [0, 1], ArrowLeft: [-1, 0], a: [-1, 0], ArrowRight: [1, 0], d: [1, 0] }[e.key];
    if (!m || G.screen !== 'dungeon') return;
    e.preventDefault();
    ui.walk = []; ui.held = m;
  }

  DS.boot = function () {
    document.getElementById('app').innerHTML = '';
    hudEl = h('div', { id: 'hud' });
    screenEl = h('div', { id: 'screen' });
    toastsEl = h('div', { id: 'toasts', 'aria-live': 'polite' });
    document.getElementById('app').append(hudEl, screenEl, toastsEl);
    G = (storage() && DS.loadFromStorage(storage())) || DS.newGame(Date.now());
    if (G.dungeon) DS.visitedSet(G);
    if (G.screen === 'judgment') G.judgment = G.judgment || { remaining_ms: DS.db.dungeon.judgment_seconds * 1000 };
    if (G.char) G.msgs.push('이어하기: 저장된 상태에서 계속합니다.');
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', () => { ui.held = null; });
    document.addEventListener('visibilitychange', () => { if (document.hidden) save(true); });
    window.addEventListener('pagehide', () => save(true));
    render();
    requestAnimationFrame((t) => { last = t; frame(t); });
  };
})();
