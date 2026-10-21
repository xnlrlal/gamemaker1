/* DOM·캔버스 UI. 게임 규칙은 game.js / combat.js / world.js 에만 있고, 여기서는 상태를 그리고 입력을 전달만 한다.
 * 화면은 "창(window)" 단위로 조립한다: 제목판 + 아치 부조 + 본문. 같은 창을 마을(인라인)과 미궁(오버레이)에서 재사용한다. */
(function () {
  const DS = globalThis.DS;
  let G = null;
  let toastsEl, screenEl, modalEl;
  const ui = { weapon: 'greatsword', confirmReset: false, mapMode: 'local', walk: [], held: null, stepT: 0,
    prev: null, alpha: 1, saveT: 0, log: [], modal: null, tip: null, armed: null, hpAtWalk: 0 };

  // ---------------------------------------------------------- 유틸
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const k in attrs || {}) {
      const v = attrs[k];
      if (v === false || v === null || v === undefined) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
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
  const icon = (name) => h('span', { html: DS.iconSvg(name), style: 'display:contents' });
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
  const sign = (v) => (v > 0 ? '+' : '') + v;
  const bonusText = (b) => Object.entries(b).map(([k, v]) => nameOfStat(k) + sign(v)).join(' · ') || '—';

  function bar(kind, value, max, extra) {
    const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
    const i = h('i'); i.style.width = pct + '%';
    return h('div', { class: 'bar ' + kind, role: 'progressbar', 'aria-valuenow': fmt(value), 'aria-valuemax': fmt(max) }, i,
      h('span', {}, fmt(value) + '/' + fmt(max) + (extra || '')));
  }

  /** 창: 제목판 + (선택) 아치 부조 + 본문. onClose 가 있으면 X 버튼. */
  function win(title, body, opts) {
    opts = opts || {};
    return h('section', { class: 'win' + (opts.cls ? ' ' + opts.cls : '') },
      h('div', { class: 'win-head' }, h('div', { class: 'win-title' }, title),
        opts.onClose ? h('button', { class: 'win-x', 'aria-label': '닫기', onclick: opts.onClose }, '✕') : null),
      opts.arches === false ? null : h('span', { html: DS.archBand(opts.archCount || 7), style: 'display:block' }),
      h('div', { class: 'win-body' }, body));
  }

  function slot(o) {
    const el = h(o.onclick ? 'button' : 'div', {
      class: 'slot' + (o.cls ? ' ' + o.cls : '') + (o.locked ? ' locked' : '') + (o.sel ? ' sel' : ''),
      'aria-label': o.label || null, onclick: o.onclick || null,
    }, o.icon ? icon(o.icon) : null,
    o.locked ? icon('lock') : null,
    o.count > 1 ? h('span', { class: 'count' }, o.count) : null,
    o.dura !== undefined && o.dura !== null ? h('span', { class: 'dura' + (o.dura < 0.34 ? ' low' : '') }, (() => { const i = h('i'); i.style.width = Math.round(o.dura * 100) + '%'; return i; })()) : null,
    o.tag ? h('span', { class: 'lbl' }, o.tag) : null);
    return el;
  }

  // 로그 색칠: 숫자·치명타·상태이상·실패를 색으로 구분한다.
  const TOKEN = /(치명타|회피|기절 저항|출혈|독|기절|쓰러짐|전투불능|헤드샷 즉사!|파손\(사라짐\)|\d+(?:\.\d+)?)/g;
  function colorize(line) {
    const out = [];
    for (const part of line.split(TOKEN)) {
      if (!part) continue;
      let cls = null;
      if (/^\d/.test(part)) cls = 'n';
      else if (part === '치명타') cls = 'crit';
      else if (part === '회피' || part === '기절 저항') cls = 'miss';
      else if (['출혈', '독', '기절'].includes(part)) cls = 'st';
      else cls = 'bad';
      out.push(h('span', { class: cls }, part));
    }
    return out;
  }
  const logLines = (lines, newFrom) => lines.map((l, i) => h('div', { class: newFrom !== undefined && i < newFrom ? 'dim' : '' }, colorize(l)));

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

  // ---------------------------------------------------------- 공용 창: 소지품 / 캐릭터
  const SLOT_ICON = { weapon: null, top: 'top', bottom: 'bottom', shoes: 'shoes' };

  function itemInfo(key) {
    const p = G.char.player;
    if (key.startsWith('gear:')) {
      const g = p.gear.find((x) => x.id === key.slice(5));
      if (!g) return null;
      const db = DS.db.equipment, def = db.weapons[g.id] || db.armor[g.id];
      return { name: g.name, sub: (g.slot === 'weapon' ? '무기' : '방어구') + ' · 일반', main: bonusText(g.bonuses),
        lines: Object.entries(g.bonuses).map(([k, v]) => [nameOfStat(k), sign(v), v >= 0 ? 'pos' : 'neg']),
        dura: g.durability === null ? null : g.durability + '/' + g.max_durability, flavor: def.desc, price: null };
    }
    if (key.startsWith('item:maseok_')) {
      const grade = key.split('_')[1];
      return { name: grade + '등급 마석', sub: '마석 · 소모품 아님', main: '환전가 ' + DS.db.economy.exchange_rate_by_grade[grade] + '스톤', lines: [], dura: null,
        flavor: '몬스터가 빛이 되어 사라진 자리에 남는 결정. 환전소에서 스톤으로 바꾼다.', price: DS.db.economy.exchange_rate_by_grade[grade] };
    }
    return null;
  }

  function tooltip() {
    const info = ui.tip && itemInfo(ui.tip);
    if (!info) return h('div', { class: 'tip muted small' }, '아이템을 누르면 설명이 보입니다.');
    return h('div', { class: 'tip' },
      h('h3', {}, info.name), h('div', { class: 'sub' }, info.sub), h('div', { class: 'main' }, info.main),
      info.lines.map(([k, v, c]) => h('div', { class: 'kv' }, h('span', {}, k), h('b', { class: c }, v))),
      info.dura ? h('div', { class: 'kv' }, h('span', {}, '내구도'), h('b', {}, info.dura)) : null,
      info.flavor ? h('div', { class: 'flavor' }, info.flavor) : null,
      info.price ? h('div', { class: 'price' }, h('span', { html: DS.iconSvg('coin'), style: 'display:contents' }), info.price) : null);
  }

  function inventoryWin(onClose) {
    const c = G.char, p = c.player;
    const gearBySlot = (s) => p.gear.find((g) => g.slot === s);
    const gearSlot = (s, tag, cls, tall) => {
      const g = gearBySlot(s);
      if (!g) return slot({ locked: true, cls: tall ? 'tall' : '', tag });
      const ic = s === 'weapon' ? g.id : s;
      const key = 'gear:' + g.id;
      return slot({ icon: ic, cls: (cls || '') + (tall ? ' tall' : ''), tag, label: g.name, sel: ui.tip === key,
        dura: g.durability === null ? null : g.durability / g.max_durability, onclick: () => { ui.tip = key; render(); } });
    };
    const locked = (tag, tall) => slot({ locked: true, tag, cls: tall ? 'tall' : '' });
    const maseok = Object.entries(c.items).filter(([k]) => k.startsWith('maseok_')).sort();
    const cells = [];
    for (const [k, n] of maseok) cells.push(slot({ icon: 'gem', cls: 'gem', count: n, label: k.split('_')[1] + '등급 마석', sel: ui.tip === 'item:' + k, onclick: () => { ui.tip = 'item:' + k; render(); } }));
    while (cells.length < 24) cells.push(slot({}));
    return win('소지품', [
      h('div', { class: 'doll' },
        gearSlot('weapon', '무기', '', true), gearSlot('top', '상의', 'leather'), gearSlot('bottom', '하의', 'leather'), locked('투구'), locked('보조', true),
        gearSlot('shoes', '신발', 'leather'), locked('장신구'), locked('허리')),
      h('div', { class: 'goldrow' }, h('span', { html: DS.iconSvg('coin'), style: 'display:contents' }), h('span', { class: 'num' }, c.stones)),
      h('div', { class: 'invgrid' }, cells),
      tooltip(),
    ], { onClose });
  }

  function characterWin(onClose) {
    const c = G.char, p = c.player, lv = DS.level(G);
    const t = DS.db.progression.exp_to_level;
    const nextExp = lv < t.length ? t[lv] : c.exp, baseExp = t[lv - 1];
    const xpPct = Math.min(100, Math.max(0, ((c.exp - baseExp) / Math.max(1, nextExp - baseExp)) * 100));
    const xpi = h('i'); xpi.style.width = xpPct + '%';
    const hurt = (part) => p.damaged_parts.includes(part);
    const partEl = (part, name, style) => h('div', { class: 'part' + (hurt(part) ? ' hurt' : ''), style }, name, h('i'));
    const attrs = ['strength', 'phys_res', 'regen', 'accuracy', 'flexibility', 'agility'];
    const statuses = Object.entries(p.status).map(([sid, e]) => (DS.db.status_names[sid] || sid) + ' ×' + e.stacks);
    return win('캐릭터', [
      h('div', { class: 'charhead' },
        h('div', { class: 'portrait', html: DS.iconSvg('person') }),
        h('div', { class: 'who' },
          h('b', {}, p.name), h('div', { class: 'small muted' }, '레벨 ' + lv + ' · 정수 슬롯 ' + lv),
          h('div', { class: 'xpbar' }, xpi, h('span', {}, c.exp + '/' + nextExp)))),
      h('div', { class: 'attrs' }, attrs.map((k) => {
        const v = DS.effStat(p, k), base = p.base_stats[k] || 0;
        return h('div', { class: 'kv' }, h('span', {}, nameOfStat(k)), h('b', { class: v > base ? 'good' : v < base ? 'bad' : '' }, v));
      }), h('div', { class: 'kv' }, h('span', {}, '최대 영혼력'), h('b', {}, fmt(p.max_spirit)))),
      h('div', { class: 'bodycols' },
        h('div', { class: 'bodydia' },
          h('span', { html: '<svg viewBox="0 0 60 120" fill="currentColor" aria-hidden="true"><circle cx="30" cy="12" r="9"/><path d="M14 26h32l4 36h-8l-2-22v32H20V40l-2 22h-8z"/><path d="M20 72h9v40h-9zM31 72h9v40h-9z"/></svg>', style: 'display:contents' }),
          partEl('head', '머리', 'left:28%;top:2px'), partEl('torso', '몸통', 'left:28%;top:36%'),
          partEl('right_arm', '오른팔', 'left:2px;top:50%'), partEl('left_arm', '왼팔', 'right:2px;top:50%;text-align:right'),
          partEl('right_leg', '오른다리', 'left:2px;bottom:6px'), partEl('left_leg', '왼다리', 'right:2px;bottom:6px;text-align:right')),
        h('div', { class: 'attrs' },
          h('div', { class: 'sect' }, '건강'),
          h('div', { class: 'kv' }, h('span', {}, '포만감'), h('b', { class: 'muted' }, '준비 중')),
          h('div', { class: 'kv' }, h('span', {}, '수분'), h('b', { class: 'muted' }, '준비 중')),
          h('div', { class: 'kv' }, h('span', {}, '피로도'), h('b', { class: 'muted' }, '준비 중')),
          h('div', { class: 'sect' }, '정신'),
          h('div', { class: 'kv' }, h('span', {}, '정신'), h('b', { class: 'good' }, p.base_stats.mind)),
          h('div', { class: 'sect' }, '상태'),
          statuses.length ? statuses.map((s) => h('div', { class: 'kv' }, h('span', { class: 'bad' }, s))) : h('div', { class: 'small muted' }, '증상 없음'))),
    ], { onClose });
  }

  // ---------------------------------------------------------- 하단 HUD (바 + 메뉴)
  function hudBottom(extra) {
    const p = G.char.player;
    const mb = (ic, label, fn) => h('button', { class: 'mbtn', 'aria-label': label, onclick: fn }, icon(ic));
    return h('div', { class: 'hud' },
      h('div', { class: 'bars' }, bar('hp', p.hp, p.max_hp), bar('mp', p.spirit, p.max_spirit)),
      p.shield > 0 ? bar('sh thin', p.shield, 40) : null,
      extra,
      h('div', { class: 'menurow' },
        h('div', { class: 'menubtns' }, mb('bag', '소지품', () => openModal('inv')), mb('person', '캐릭터', () => openModal('char'))),
        h('div', { class: 'hudinfo' }, 'Lv ', h('b', {}, DS.level(G)), ' · 스톤 ', h('b', {}, G.char.stones)),
        h('div', { class: 'menubtns' }, mb('map', '지도 전환', () => { ui.mapMode = ui.mapMode === 'local' ? 'full' : 'local'; render(); }), mb('gear', '메뉴', () => openModal('menu')))));
  }

  function openModal(name) { ui.modal = name; ui.tip = null; render(); }
  function closeModal() { ui.modal = null; ui.tip = null; render(); }

  function resetBlock() {
    return ui.confirmReset
      ? h('div', { class: 'row wrap' },
        h('span', { class: 'small muted grow' }, '정말 처음부터 시작할까요?'),
        h('button', { class: 'btn danger', onclick: () => { DS.clearSave(storage()); G = DS.newGame(Date.now()); ui.confirmReset = false; ui.modal = null; ui.log = []; render(); } }, '삭제하고 새 게임'),
        h('button', { class: 'btn', onclick: () => { ui.confirmReset = false; render(); } }, '취소'))
      : h('button', { class: 'btn', onclick: () => { ui.confirmReset = true; render(); } }, '저장 삭제 / 새 게임');
  }

  function renderModal() {
    modalEl.replaceChildren();
    modalEl.classList.toggle('open', !!ui.modal && !!G.char);
    if (!ui.modal || !G.char) return;
    const body = {
      inv: () => inventoryWin(closeModal),
      char: () => characterWin(closeModal),
      menu: () => win('메뉴', [
        h('p', { class: 'small muted' }, '진행은 이 기기에 자동 저장됩니다. 미궁 안에서는 스스로 마을로 돌아올 수 없습니다.'),
        ui.log.length ? [h('div', { class: 'sect' }, '기록'), h('div', { class: 'log' }, logLines(ui.log.slice(0, 12)))] : null,
        resetBlock(),
      ], { onClose: closeModal }),
    }[ui.modal];
    modalEl.append(body());
  }

  // ---------------------------------------------------------- 화면: 캐릭터 생성
  function screenCreate() {
    const weapons = DS.db.equipment.weapons;
    return [
      h('div', { class: 'hero' },
        h('span', { class: 'tag' }, '프로토타입 v0'),
        h('h1', {}, '던전 앤 스톤'),
        h('p', { class: 'muted' }, '이 게임을 해 본 사람이 그 세계에 떨어졌다. 아는 것이 힘이지만, 아는 것과 살아남는 것은 다르다. 한 번 죽으면 모든 것을 잃는다.')),
      win('바바리안 성인식', [
        h('p', { class: 'muted small' }, '무기 6종 중 하나를 고릅니다. 천 상의·천 하의·샌들이 자동 지급됩니다.'),
        h('div', { class: 'weapons' }, Object.entries(weapons).map(([id, w]) =>
          h('button', { class: 'slot weapon', 'aria-pressed': ui.weapon === id, onclick: () => { ui.weapon = id; render(); } },
            icon(id), h('b', {}, w.name_ko), h('span', {}, bonusText(w.bonuses))))),
        h('p', { class: 'small muted' }, weapons[ui.weapon].desc),
        h('button', { class: 'btn primary', onclick: () => { DS.createChar(G, ui.weapon); ui.walk = []; save(true); render(); } }, '성인식 시작'),
      ]),
      h('p', { class: 'muted small' }, '수치는 모두 임시값입니다. 진행은 이 기기에 자동 저장되고, 사망하면 처음부터 다시 시작합니다.'),
    ];
  }

  // ---------------------------------------------------------- 화면: 마을
  function screenTown() {
    const c = G.char, p = c.player;
    const maseokCount = Object.keys(c.items).some((k) => k.startsWith('maseok_'));
    return [
      win('라프도니아 성채', [
        h('div', { class: 'bars' }, bar('hp', p.hp, p.max_hp), bar('mp', p.spirit, p.max_spirit)),
        h('p', { class: 'small muted' }, '마을 ' + G.town.day + '일째. 미궁은 정해진 주기에만 열립니다. 다음 판단 시점까지 건너뛰면 입장 여부를 묻는 판단창이 뜹니다. 미궁 안에서는 스스로 돌아올 수 없고, 정해진 체류일이 지나면 강제로 귀환합니다.'),
        h('button', { class: 'btn primary', onclick: () => { DS.townSkip(G); save(true); render(); } }, '다음 판단 시점까지 건너뛰기'),
        h('button', { class: 'btn', disabled: !c.returned_once || !maseokCount, onclick: () => {
          const total = DS.exchange(G);
          G.msgs.push('환전소: 스톤 +' + total);
          save(true); render();
        } }, c.returned_once ? '환전소: 마석 전부 바꾸기' : '환전소 (첫 미궁 귀환 후 열림)'),
      ]),
      characterWin(),
      inventoryWin(),
      win('기록', [
        ui.log.length ? h('div', { class: 'log' }, logLines(ui.log.slice(0, 12))) : h('p', { class: 'small muted' }, '아직 기록이 없습니다.'),
        resetBlock(),
      ], { arches: false }),
    ];
  }

  // ---------------------------------------------------------- 화면: 판단창
  function screenJudgment() {
    return [win('판단', [
      h('div', { class: 'judgment', style: 'display:flex;flex-direction:column' },
        h('h2', {}, '미궁에 들어가시겠습니까?'),
        h('div', { class: 'countdown', id: 'judg-cd' }, Math.ceil(G.judgment.remaining_ms / 1000)),
        h('p', { class: 'muted small' }, '무응답은 거부입니다. 거부해도 불이익은 없고 다음 주기를 기다립니다.'),
        h('div', { class: 'row', style: 'width:100%' },
          h('button', { class: 'btn grow', onclick: () => { DS.declineJudgment(G); save(true); render(); } }, '거부'),
          h('button', { class: 'btn primary grow', onclick: () => { DS.enterDungeon(G); ui.walk = []; ui.prev = null; save(true); render(); } }, '입장'))),
    ])];
  }

  // ---------------------------------------------------------- 화면: 미궁 (지도 위 턴제 전투)
  function zoneLabel() {
    const floor = DS.getFloor();
    const z = DS.zoneAt(floor, G.dungeon.pos.x, G.dungeon.pos.y);
    return '1층 ' + DS.db.dungeon.floor1.name + ' · ' + DS.db.zone_names[z];
  }
  function clockText() {
    const d = DS.dungeonDays(G), max = DS.db.dungeon.floor1.forced_return_days;
    const day = Math.min(max, Math.floor(d) + 1);
    return '미궁 ' + day + '일째 · 귀환까지 ' + Math.max(0, Math.ceil((max - d) * DS.db.dungeon.seconds_per_day)) + '초';
  }
  const visibleMonsters = () => G.dungeon.monsters.filter((m) => m.alive && DS.canSee(G, m));
  const turnText = () => '턴 ' + G.dungeon.turn + (DS.alertMonsters(G).length ? ' · 전투 중 (적 ' + DS.alertMonsters(G).length + ')' : '');

  function statusIcons() {
    const p = G.char.player;
    return Object.entries(p.status).map(([sid, e]) => h('span', { title: DS.db.status_names[sid] || sid, style: 'color:var(--bad)' }, icon(sid === 'poison' ? 'drop' : 'drop'), e.stacks > 1 ? h('small', {}, e.stacks) : null));
  }

  function skillSlot(sid, i) {
    const p = G.char.player, s = DS.db.skills[sid];
    const cd = p.cooldowns[sid] || 0;
    const noMp = cd === 0 && p.spirit < s.cost;
    const val = s.kind === 'attack' ? '위력 ' + fmt(DS.skillValue(null, p, sid)) + ' · 사거리 ' + DS.skillRange(p, sid) : '방어막 ' + fmt(DS.skillValue(null, p, sid));
    const extra = (s.on_hit || []).map((e) => DS.db.status_names[e.status] || e.status).join('·');
    return h('button', { class: 'slot skill' + (ui.armed === sid ? ' on' : '') + (noMp ? ' nomp' : ''), disabled: cd > 0 || noMp, onclick: () => onSkill(sid),
      'aria-label': s.name_ko + ', ' + val + ', 영혼력 ' + s.cost + ', 쿨타임 ' + s.cooldown + '턴' },
      h('span', { class: 'key' }, (i + 1) % 10), h('span', { class: 'cost' }, s.cost),
      icon(DS.skillIcon(sid)), h('span', { class: 'nm' }, s.name_ko),
      h('span', { class: 'info' }, h('span', {}, s.kind === 'attack' ? '위력 ' + fmt(DS.skillValue(null, p, sid)) : '방어막 ' + fmt(DS.skillValue(null, p, sid))),
        h('span', {}, (s.kind === 'attack' ? '거리 ' + DS.skillRange(p, sid) : '자신') + (extra ? ' · ' + extra : ''))),
      h('span', { class: 'cd' }, cd > 0 ? cd : noMp ? '영혼력' : ''));
  }
  const waitSlot = () => h('button', { class: 'slot skill', onclick: () => act(() => DS.playerWait(G)), 'aria-label': '대기(한 턴 넘기기)' },
    h('span', { class: 'key' }, '0'), icon('wait'), h('span', { class: 'nm' }, '대기'), h('span', { class: 'info' }, h('span', {}, '한 턴'), h('span', {}, '넘기기')));

  function hotbarEl() { return h('div', { class: 'hotbar' }, G.char.player.skills.map(skillSlot), waitSlot()); }

  function screenDungeon() {
    const canvas = h('canvas', { id: 'map', width: 480, height: 560, 'aria-label': '미궁 지도. 탭하면 그 칸으로 이동합니다. 적을 탭하면 공격합니다.' });
    canvas.addEventListener('pointerdown', onMapTap);
    const dir = (name, label, glyph, dx, dy) => {
      const b = h('button', { class: name, 'aria-label': label }, glyph);
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        try { b.setPointerCapture(e.pointerId); } catch (err) { /* 일부 브라우저는 캡처를 못 한다 */ }
        ui.walk = []; ui.held = [dx, dy];
      });
      // 손가락이 버튼 밖으로 살짝 벗어나도 놓을 때까지 계속 걷는다(포인터 캡처).
      for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, () => { ui.held = null; });
      return b;
    };
    const stage = h('div', { class: 'stage' }, canvas,
      h('div', { class: 'tracker' }, h('b', {}, '탐험'), h('span', { id: 'zone' }, zoneLabel()), h('br'), h('span', { id: 'clock', class: 'num' }, clockText()), h('br'), h('span', { id: 'turn', class: 'num' }, turnText())),
      h('div', { class: 'statusicons', id: 'sticons' }, statusIcons()),
      h('div', { class: 'stagelog', id: 'stagelog' }, logLines(G.dungeon.log.slice(-4))),
      h('div', { class: 'dpad' }, dir('up', '위', '▲', 0, -1), dir('left', '왼쪽', '◀', -1, 0), dir('down', '아래', '▼', 0, 1), dir('right', '오른쪽', '▶', 1, 0)));
    return [stage, h('div', { id: 'hudwrap', style: 'display:contents' }, hudBottom(hotbarEl()))];
  }

  /** 걸을 때마다 화면을 통째로 다시 그리지 않고(D패드 누름이 끊긴다) 바뀌는 부분만 갱신한다. */
  function refreshDungeon() {
    if (G.screen !== 'dungeon') return;
    const hw = document.getElementById('hudwrap');
    if (hw) hw.replaceChildren(hudBottom(hotbarEl()));
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('zone', zoneLabel()); set('turn', turnText());
    const lg = document.getElementById('stagelog'); if (lg) lg.replaceChildren(...logLines(G.dungeon.log.slice(-4)));
    const si = document.getElementById('sticons'); if (si) si.replaceChildren(...statusIcons());
  }

  const tileSize = () => (ui.mapMode === 'local' ? 36 : 12);

  /** 한 번의 플레이어 행동(=한 턴)을 실행하고 화면을 갱신한다. */
  function act(fn) {
    if (G.screen !== 'dungeon') return null;
    const hp0 = G.char.player.hp;
    const r = fn();
    if (r && !r.ok && r.reason && r.reason !== 'wall') G.msgs.push(r.reason);
    if (r && r.ok) ui.armed = null;
    flushMsgs();
    save(G.screen !== 'dungeon');
    if (G.screen !== 'dungeon') { ui.walk = []; ui.held = null; ui.armed = null; render(); return r; }
    if (G.char.player.hp < hp0) ui.walk = []; // 맞으면 자동 이동을 멈춘다
    refreshDungeon();
    return r;
  }

  function onSkill(sid) {
    if (G.screen !== 'dungeon') return;
    const s = DS.db.skills[sid];
    if (s.kind === 'defend') { act(() => DS.playerSkill(G, sid)); return; }
    if (ui.armed === sid) { ui.armed = null; render(); return; }
    const targets = visibleMonsters().filter((m) => DS.canUseSkill(G, sid, m).ok);
    if (!targets.length) { G.msgs.push('사거리 안에 적이 없습니다.'); flushMsgs(); return; }
    if (targets.length === 1) { act(() => DS.playerSkill(G, sid, targets[0].uid)); return; } // 대상이 하나면 바로 사용
    ui.armed = sid; render(); // 여러 마리면 대상을 고른다
  }

  function onMapTap(e) {
    if (G.screen !== 'dungeon') return;
    const r = e.currentTarget.getBoundingClientRect(), ts = tileSize(); // 타일 크기는 CSS 픽셀 기준
    const pos = G.dungeon.pos;
    const tx = Math.round(pos.x + (e.clientX - r.left - r.width / 2) / ts), ty = Math.round(pos.y + (e.clientY - r.top - r.height / 2) / ts);
    const m = DS.monsterAt(G, tx, ty);
    if (m && DS.canSee(G, m)) {
      if (ui.armed) { act(() => DS.playerSkill(G, ui.armed, m.uid)); return; }
      const chk = DS.canUseSkill(G, 'slash', m);
      if (chk.ok || DS.manhattan(pos, m.pos) === 1) { act(() => DS.playerAttackDefault(G, m.uid)); return; }
      // 멀리 있으면 가까이 다가간다(적이 경계 중이면 한 걸음씩)
      const path = DS.findPath(DS.getFloor(), pos, m.pos);
      if (path && path.length > 1) { ui.walk = path.slice(0, -1); ui.held = null; ui.hpAtWalk = G.char.player.hp; }
      return;
    }
    const path = DS.findPath(DS.getFloor(), pos, { x: tx, y: ty });
    // 지도에 보이는 칸만 목적지로 허용한다(가보지 않은 곳의 존재를 드러내지 않는다).
    if (path && path.length && visible(tx, ty)) { ui.walk = path; ui.held = null; ui.hpAtWalk = G.char.player.hp; }
  }

  /** 지도에 보이는 칸. 로컬맵은 주변 반경 안, 전체맵은 가본 칸(과 그 벽)만. 안 가본 먼 칸은 흐린 표시조차 하지 않는다(7-1). */
  function visible(x, y) {
    const floor = DS.getFloor(), vs = DS.visitedSet(G);
    if (ui.mapMode === 'local') {
      const p = G.dungeon.pos;
      if (Math.hypot(x - p.x, y - p.y) <= DS.visionRadius(G)) return true;
    }
    if (vs.has(y * floor.width + x)) return true;
    for (const [dx, dy] of DS.DIRS) if (vs.has((y + dy) * floor.width + (x + dx))) return true;
    return false;
  }

  const hash = (x, y, k) => { let n = (x * 374761393 + y * 668265263 + k * 2147483647) | 0; n = (n ^ (n >>> 13)) * 1274126177; return ((n ^ (n >>> 16)) >>> 0) / 4294967296; };

  const FAMILY = { gnome: ['person', '#7da05a'], goblin: ['person', '#6a9a4a'], ghoul: ['person', '#a9b38f'], blade_wolf: ['beast', '#8d8f98'], wolf: ['beast', '#85766a'] };

  function drawFigure(ctx, kind, color, px, py, u) {
    if (kind === 'beast') {
      ctx.fillStyle = color; ctx.fillRect(px - u * 4, py - u * 1.5, u * 8, u * 3.2);
      ctx.fillRect(px + u * 3, py - u * 3, u * 3, u * 2.6);
      ctx.fillStyle = '#2a2a33'; ctx.fillRect(px - u * 3.5, py + u * 1.6, u * 1.4, u * 2); ctx.fillRect(px + u * 1.8, py + u * 1.6, u * 1.4, u * 2);
      ctx.fillStyle = '#e8d070'; ctx.fillRect(px + u * 4.8, py - u * 2.4, u * 0.9, u * 0.9);
      return;
    }
    ctx.fillStyle = color; ctx.fillRect(px - u * 2.2, py - u * 4, u * 4.4, u * 3);
    ctx.fillStyle = '#4a3b33'; ctx.fillRect(px - u * 3, py - u, u * 6, u * 5);
    ctx.fillStyle = '#2a2a33'; ctx.fillRect(px - u * 2.5, py + u * 4, u * 2, u * 2.4); ctx.fillRect(px + u * 0.5, py + u * 4, u * 2, u * 2.4);
    ctx.fillStyle = '#9a9aa8'; ctx.fillRect(px - u * 4.2, py - u * 3, u * 1.1, u * 6);
  }

  function drawBracket(ctx, x, y, size, color, dpr) {
    const l = size * 0.28;
    ctx.strokeStyle = color; ctx.lineWidth = 2 * dpr;
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const cx = x + sx * size / 2, cy = y + sy * size / 2;
      ctx.beginPath(); ctx.moveTo(cx, cy - sy * l); ctx.lineTo(cx, cy); ctx.lineTo(cx - sx * l, cy); ctx.stroke();
    }
  }

  function drawMap() {
    const cv = document.getElementById('map');
    if (!cv || !G.dungeon) return;
    // 캔버스 해상도를 표시 크기에 맞춘다(선명하게)
    const r = cv.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const ctx = cv.getContext('2d'), floor = DS.getFloor();
    const local = ui.mapMode === 'local';
    const ts = tileSize() * dpr;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    const pos = G.dungeon.pos, prev = ui.prev || pos;
    const cx = prev.x + (pos.x - prev.x) * ui.alpha, cy = prev.y + (pos.y - prev.y) * ui.alpha;
    const halfX = Math.ceil(W / ts / 2) + 1, halfY = Math.ceil(H / ts / 2) + 1;
    const vs = DS.visitedSet(G);
    const lightR = DS.visionRadius(G) + 0.6;
    for (let y = Math.floor(cy) - halfY; y <= Math.ceil(cy) + halfY; y++) {
      for (let x = Math.floor(cx) - halfX; x <= Math.ceil(cx) + halfX; x++) {
        if (x < 0 || y < 0 || x >= floor.width || y >= floor.height || !visible(x, y)) continue;
        const sx = Math.round(W / 2 + (x - cx) * ts - ts / 2), sy = Math.round(H / 2 + (y - cy) * ts - ts / 2), size = Math.ceil(ts);
        const open = floor.grid[y][x] === 0;
        const d = Math.hypot(x - cx, y - cy);
        const remembered = vs.has(y * floor.width + x) ? 0.4 : 0.18;
        const lit = local ? Math.max(0, 1 - Math.max(0, d - 1.2) / lightR) : 0;
        const b = Math.max(remembered, lit);
        const v = hash(x, y, 1);
        if (open) {
          const g = 58 + v * 16;
          ctx.fillStyle = 'rgb(' + g * b * 1.05 + ',' + g * b + ',' + g * b * 1.12 + ')';
        } else {
          const g = 34 + v * 10;
          ctx.fillStyle = 'rgb(' + g * b + ',' + g * b * 0.98 + ',' + g * b * 1.1 + ')';
        }
        ctx.fillRect(sx, sy, size, size);
        if (ts > 20) {
          if (open) {
            ctx.fillStyle = 'rgba(0,0,0,' + 0.25 * b + ')';
            for (let i = 0; i < 3; i++) { const px = hash(x, y, 10 + i) * (size - 4), py = hash(x, y, 20 + i) * (size - 4); ctx.fillRect(sx + px, sy + py, 3 * dpr, 2 * dpr); }
            ctx.fillStyle = 'rgba(255,255,255,' + 0.05 * b + ')';
            ctx.fillRect(sx + hash(x, y, 30) * (size - 8), sy + hash(x, y, 31) * (size - 8), 4 * dpr, 2 * dpr);
          } else {
            ctx.strokeStyle = 'rgba(0,0,0,' + 0.55 * b + ')';
            ctx.lineWidth = dpr;
            ctx.strokeRect(sx + 0.5, sy + 0.5, size - 1, size / 2 - 1);
            ctx.strokeRect(sx + 0.5, sy + size / 2 + 0.5, size - 1, size / 2 - 1);
            ctx.beginPath(); ctx.moveTo(sx + size * (0.3 + 0.4 * v), sy); ctx.lineTo(sx + size * (0.3 + 0.4 * v), sy + size / 2); ctx.stroke();
          }
        }
      }
    }
    for (const portal of floor.portals) {
      if (!visible(portal.x, portal.y)) continue;
      const sx = W / 2 + (portal.x - cx) * ts, sy = H / 2 + (portal.y - cy) * ts;
      const found = G.char.portals.includes(portal.id);
      const gl = ctx.createRadialGradient(sx, sy, 0, sx, sy, ts * 0.8);
      gl.addColorStop(0, found ? 'rgba(110,210,130,0.95)' : 'rgba(120,170,255,0.95)'); gl.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(sx, sy, ts * 0.8, 0, Math.PI * 2); ctx.fill();
    }
    // 몬스터: 시야(밝은 곳 + 시선)에 들어온 적만 보인다.
    const u = Math.max(2.4, ts * 0.058);
    const armedTargets = ui.armed ? new Set(visibleMonsters().filter((m) => DS.canUseSkill(G, ui.armed, m).ok).map((m) => m.uid)) : new Set();
    if (local) {
      for (const m of G.dungeon.monsters) {
        if (!m.alive || !DS.canSee(G, m)) continue;
        const sx = W / 2 + (m.pos.x - cx) * ts, sy = H / 2 + (m.pos.y - cy) * ts;
        const fam = FAMILY[m.id] || ['person', '#b0696a'];
        drawFigure(ctx, fam[0], fam[1], sx, sy, u);
        const bw = ts * 0.78, by = sy - ts * 0.5;
        if (m.hp < m.max_hp || m.alert) {
          ctx.fillStyle = '#000b'; ctx.fillRect(sx - bw / 2, by, bw, 4 * dpr);
          ctx.fillStyle = '#c4343d'; ctx.fillRect(sx - bw / 2, by, bw * Math.max(0, m.hp / m.max_hp), 4 * dpr);
        }
        if (m.alert) {
          ctx.font = 'bold ' + 11 * dpr + 'px sans-serif'; ctx.textAlign = 'center'; ctx.lineWidth = 3 * dpr;
          ctx.strokeStyle = '#000'; ctx.strokeText('적!', sx, by - 3 * dpr); ctx.fillStyle = '#fff'; ctx.fillText('적!', sx, by - 3 * dpr);
        }
        if (armedTargets.has(m.uid)) drawBracket(ctx, sx, sy, ts * 0.96, '#ffd36a', dpr);
      }
    }
    // 횃불 빛과 어둠: 플레이어 주변만 밝고 바깥은 서서히 검게(스톤샤드식 시야).
    if (local) {
      const gx = W / 2, gy = H / 2, R = lightR * ts;
      const g = ctx.createRadialGradient(gx, gy, ts * 0.8, gx, gy, R);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.7, 'rgba(0,0,0,0.25)'); g.addColorStop(1, 'rgba(0,0,0,0.78)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      const warm = ctx.createRadialGradient(gx, gy, 0, gx, gy, ts * 3);
      warm.addColorStop(0, 'rgba(255,170,70,0.22)'); warm.addColorStop(1, 'rgba(255,170,70,0)');
      ctx.fillStyle = warm; ctx.fillRect(0, 0, W, H);
    }
    // 현재 위치는 항상 화면 정중앙(7-1 지도 원칙)
    const pu = Math.max(2.4, ts * 0.058);
    drawFigure(ctx, 'person', '#d8a25a', W / 2, H / 2, pu);
    ctx.fillStyle = '#c9ced8'; ctx.fillRect(W / 2 + pu * 3.2, H / 2 - pu * 3, pu * 1.1, pu * 6);
  }

  function onMapDraw() { if (G.screen === 'dungeon') drawMap(); }

  // ---------------------------------------------------------- 화면: 사망
  function screenDead() {
    const d = G.dead;
    return [win('사망', [
      h('h2', { style: 'color:var(--bad)' }, d.by + '에게 ' + d.cause),
      h('p', {}, '캐릭터와 모든 진행이 사라졌습니다.'),
      h('div', { class: 'kv' }, h('span', {}, '도달 레벨'), h('b', {}, d.level)),
      h('div', { class: 'kv' }, h('span', {}, '처치 수'), h('b', {}, d.kills)),
      h('div', { class: 'kv' }, h('span', {}, '미궁 체류'), h('b', {}, d.days + '일째 · ' + d.steps + '걸음')),
      h('button', { class: 'btn primary', onclick: () => { DS.afterDeathNewChar(G); DS.clearSave(storage()); ui.log = []; ui.modal = null; render(); } }, '새 캐릭터 만들기'),
    ])];
  }

  // ---------------------------------------------------------- 렌더 루프
  function render() {
    flushMsgs();
    const map = { create: screenCreate, town: screenTown, judgment: screenJudgment, dungeon: screenDungeon, dead: screenDead };
    const fill = G.screen === 'dungeon';
    const scrollTop = screenEl.scrollTop;
    screenEl.className = 'screen' + (fill ? ' fill' : '');
    screenEl.replaceChildren(...map[G.screen]().filter(Boolean));
    screenEl.scrollTop = fill ? 0 : scrollTop;
    renderModal();
    if (G.screen === 'dungeon') drawMap();
    window.__G = G; // 테스트·디버깅용
    DS.uiRender = render;
  }

  /** 걷기: 한 칸 = 한 턴. 지도 탭 경로·D패드 누름 모두 한 걸음씩 playerMove 를 호출한다. */
  function stepWalk(dt) {
    if (G.screen !== 'dungeon') { ui.walk = []; return; }
    const speed = DS.db.dungeon.move_tiles_per_second;
    ui.stepT += dt;
    ui.alpha = Math.min(1, ui.alpha + dt * speed);
    if (ui.stepT < 1 / speed) return;
    let dx = 0, dy = 0, fromPath = false;
    const pos = G.dungeon.pos;
    if (ui.walk.length) { dx = ui.walk[0].x - pos.x; dy = ui.walk[0].y - pos.y; fromPath = true; }
    else if (ui.held) { dx = ui.held[0]; dy = ui.held[1]; }
    else { ui.stepT = 0; return; }
    ui.stepT = 0;
    const from = { x: pos.x, y: pos.y };
    const alertBefore = DS.alertMonsters(G).length;
    const r = act(() => DS.playerMove(G, dx, dy));
    if (!r || !r.ok) { ui.walk = []; return; }
    if (G.screen !== 'dungeon') return;
    if (r.moved) { ui.prev = from; ui.alpha = 0; }
    if (fromPath) ui.walk.shift();
    // 적이 새로 눈치채거나 경계 중이면 자동 이동을 멈춘다(한 걸음씩).
    if (DS.alertMonsters(G).length > 0 && (alertBefore === 0 || fromPath)) ui.walk = [];
  }

  let last = performance.now(), clockAcc = 0;
  function frame(now) {
    const dt = Math.min(0.25, (now - last) / 1000); last = now;
    if (!document.hidden) {
      if (G.screen === 'judgment') {
        G.judgment.remaining_ms -= dt * 1000;
        const cd = document.getElementById('judg-cd');
        if (cd) cd.textContent = Math.max(0, Math.ceil(G.judgment.remaining_ms / 1000));
        if (G.judgment.remaining_ms <= 0) { DS.declineJudgment(G); save(true); render(); }
      }
      // 미궁 시계는 현실 시간으로 흐른다(턴과 별개). 강제 귀환은 전투 중에도 일어난다.
      if (G.dungeon && G.screen === 'dungeon') {
        if (DS.tickClock(G, dt * 1000)) { ui.walk = []; ui.held = null; ui.armed = null; ui.modal = null; save(true); render(); }
        else {
          clockAcc += dt;
          if (clockAcc > 0.25) { clockAcc = 0; const c = document.getElementById('clock'); if (c) c.textContent = clockText(); }
        }
      }
      stepWalk(dt);
      if (G.screen === 'dungeon') drawMap();
    }
    requestAnimationFrame(frame);
  }

  function onKey(e) {
    if (G.screen === 'dungeon' && !ui.modal && /^[0-9]$/.test(e.key)) {
      const sid = e.key === '0' ? null : G.char.player.skills[Number(e.key) - 1];
      if (e.key === '0') act(() => DS.playerWait(G)); else if (sid) onSkill(sid);
      return;
    }
    if (e.key === ' ' && G.screen === 'dungeon' && !ui.modal) { e.preventDefault(); act(() => DS.playerWait(G)); return; }
    if (e.key === 'Escape' && ui.armed) { ui.armed = null; render(); return; }
    const m = { ArrowUp: [0, -1], w: [0, -1], ArrowDown: [0, 1], s: [0, 1], ArrowLeft: [-1, 0], a: [-1, 0], ArrowRight: [1, 0], d: [1, 0] }[e.key];
    if (!m || G.screen !== 'dungeon' || ui.modal) return;
    e.preventDefault();
    ui.walk = []; ui.held = m;
  }

  DS.boot = function () {
    const app = document.getElementById('app');
    app.innerHTML = '';
    screenEl = h('div', { class: 'screen' });
    toastsEl = h('div', { id: 'toasts', 'aria-live': 'polite' });
    modalEl = h('div', { id: 'modal' });
    app.append(screenEl, modalEl, toastsEl);
    G = (storage() && DS.loadFromStorage(storage())) || DS.newGame(Date.now());
    if (G.dungeon) DS.visitedSet(G);
    if (G.screen === 'judgment') G.judgment = G.judgment || { remaining_ms: DS.db.dungeon.judgment_seconds * 1000 };
    if (G.char) G.msgs.push('이어하기: 저장된 상태에서 계속합니다.');
    // 꾹 누르기 메뉴(복사·공유 등)가 조작 중에 뜨지 않게 막는다. 전투 로그·툴팁 글자는 선택할 수 있다.
    app.addEventListener('contextmenu', (e) => { if (!e.target.closest('.tip, .log')) e.preventDefault(); });
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', () => { ui.held = null; });
    window.addEventListener('resize', onMapDraw);
    document.addEventListener('visibilitychange', () => { if (document.hidden) save(true); });
    window.addEventListener('pagehide', () => save(true));
    render();
    requestAnimationFrame((t) => { last = t; frame(t); });
  };
})();
