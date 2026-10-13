// 브라우저(실제 크로미움)에서 한 판 루프를 끝까지 돌려 본다. 사용법: node web/tests/e2e.js [스크린샷 폴더]
const { chromium } = require('playwright');
const path = require('path');
const assert = require('assert');
const shots = process.argv[2] || '/tmp';
const url = 'file://' + path.join(__dirname, '..', 'dist', 'play.html');
const TILE = 36; // 지도 타일 한 칸의 CSS 픽셀 크기(ui.js tileSize 와 같아야 한다)

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  const shot = (n) => page.screenshot({ path: path.join(shots, n + '.png') });
  const G = (fn) => page.evaluate(fn);
  const screen = () => G(() => window.__G.screen);

  await page.goto(url);
  await page.waitForSelector('text=성인식 시작');
  await shot('1-create');
  await page.click('button.weapon:has-text("대검")');
  await page.click('text=성인식 시작');
  assert.strictEqual(await screen(), 'town');
  await shot('2-town');
  await page.click('text=다음 판단 시점까지 건너뛰기');
  assert.strictEqual(await screen(), 'judgment');
  await shot('3-judgment');
  await page.click('button:has-text("입장")');
  assert.strictEqual(await screen(), 'dungeon');
  await page.waitForTimeout(300);
  await shot('4-dungeon');

  // 소지품·캐릭터 창
  await page.click('button[aria-label="소지품"]');
  await page.waitForSelector('.win-title:has-text("소지품")');
  await page.click('button[aria-label="대검"]');
  await shot('4b-inventory');
  await page.click('.win-x');
  await page.click('button[aria-label="캐릭터"]');
  await page.waitForSelector('.win-title:has-text("캐릭터")');
  await page.click('.win-x');

  // 적을 모두 치워 두고(이 구간은 이동 테스트만) D패드를 꾹 누른다: 글자 선택 없음 + 계속 걷기 + 한 칸 = 한 턴
  await G(() => { const g = window.__G; g.dungeon.monsters = []; g.dungeon.camps.forEach((c) => { c.state = 'active'; }); DS.uiRender(); });
  const noSelect = await G(() => getComputedStyle(document.querySelector('.dpad .right')).userSelect === 'none' && getComputedStyle(document.getElementById('map')).userSelect === 'none');
  assert.ok(noSelect, 'user-select none on map controls');
  const turn0 = await G(() => window.__G.dungeon.turn);
  const dp = await page.locator('.dpad .right').boundingBox();
  const p0 = await G(() => JSON.stringify(window.__G.dungeon.pos));
  await page.mouse.move(dp.x + dp.width / 2, dp.y + dp.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(900);
  const selected = await G(() => String(window.getSelection()));
  await page.mouse.up();
  assert.strictEqual(selected, '', 'long press must not select text');
  const p1 = await G(() => JSON.stringify(window.__G.dungeon.pos));
  assert.notStrictEqual(p1, p0, 'held D-pad keeps walking');
  const steps = await G(() => window.__G.dungeon.turn) - turn0;
  assert.ok(steps >= 2, 'each step is a turn: ' + steps);

  // 지도 탭 이동
  const before = await G(() => JSON.stringify(window.__G.dungeon.pos));
  const target = await G(() => {
    const g = window.__G, f = DS.getFloor(), p = g.dungeon.pos;
    for (let r = 4; r >= 1; r--) for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r]]) {
      const path = DS.findPath(f, p, { x: p.x + dx, y: p.y + dy });
      if (path && path.length) return { dx, dy };
    }
    return null;
  });
  assert.ok(target, 'walkable tile nearby');
  const box = await page.locator('#map').boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2 + target.dx * TILE, box.y + box.height / 2 + target.dy * TILE);
  await page.waitForTimeout(1200);
  assert.notStrictEqual(await G(() => JSON.stringify(window.__G.dungeon.pos)), before, 'player moved after tap');

  // 적 한 마리를 시선이 닿는 3칸 거리에 세우고: 사거리 밖이면 거부 → 다가가 → 베기 한 번으로 공격
  const placed = await G(() => {
    const g = window.__G, f = DS.getFloor(), p = g.dungeon.pos;
    for (let r = 3; r <= 4; r++) for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r]]) {
      const t = { x: p.x + dx, y: p.y + dy };
      if (DS.isOpen(f, t.x, t.y) && DS.hasLos(f, p, t)) {
        const m = DS.makeMonster('gnome'); m.uid = 'e2e1'; m.pos = t; m.alert = false; m.alert_turns = 0;
        g.dungeon.monsters = [m]; DS.uiRender();
        return { dx, dy };
      }
    }
    return null;
  });
  assert.ok(placed, 'placed an enemy');
  await page.waitForTimeout(150);
  await shot('5-enemy-visible');
  await page.click('button.skill:has-text("베기")'); // 사거리 밖: 거부 메시지
  assert.strictEqual(await G(() => window.__G.dungeon.monsters[0].hp), 100);
  // 적을 탭하면 가까이 다가간다 → 인접하면 공격
  await page.touchscreen.tap(box.x + box.width / 2 + placed.dx * TILE, box.y + box.height / 2 + placed.dy * TILE);
  await page.waitForFunction(() => { const m = window.__G.dungeon.monsters[0]; return !m || m.hp < m.max_hp || DS.manhattan(m.pos, window.__G.char.player.pos) <= 1; }, null, { timeout: 8000 });
  await shot('6-engaged');

  // 쿨타임이 이동으로 줄어드는지: 강타 → 대기값 확인
  await G(() => { const g = window.__G; g.dungeon.monsters = []; g.char.player.cooldowns = { smash: 4 }; g.char.player.spirit = 20; DS.uiRender(); });
  await page.keyboard.press('Space'); // 대기도 한 턴
  assert.strictEqual(await G(() => window.__G.char.player.cooldowns.smash), 3);

  // 여러 마리 + 스킬 선택(조준): 두 마리를 인접하게 세우고 강타를 고른 뒤 한 마리를 탭
  await G(() => {
    const g = window.__G, f = DS.getFloor(), p = g.dungeon.pos, ms = [];
    for (const [dx, dy] of DS.DIRS) if (DS.isOpen(f, p.x + dx, p.y + dy) && ms.length < 2) {
      const m = DS.makeMonster('gnome'); m.uid = 'k' + ms.length; m.pos = { x: p.x + dx, y: p.y + dy }; m.alert = true; m.alert_turns = 6; ms.push(m);
    }
    g.dungeon.monsters = ms; g.char.player.cooldowns = {}; g.char.player.spirit = 20; DS.uiRender();
  });
  const two = await G(() => window.__G.dungeon.monsters.length);
  if (two >= 2) {
    await page.click('button.skill:has-text("강타")');
    assert.strictEqual(await G(() => window.__G.dungeon.monsters.length), 2, 'armed, waiting for a target');
    await shot('7-armed');
    const off = await G(() => { const g = window.__G, m = g.dungeon.monsters[0]; return { dx: m.pos.x - g.dungeon.pos.x, dy: m.pos.y - g.dungeon.pos.y }; });
    await page.touchscreen.tap(box.x + box.width / 2 + off.dx * TILE, box.y + box.height / 2 + off.dy * TILE);
    await page.waitForTimeout(200);
    const hurt = await G(() => window.__G.dungeon.monsters.some((m) => m.hp < m.max_hp));
    assert.ok(hurt, 'armed skill hit the tapped target');
    await shot('8-after-hit');
  }

  // 저장/이어하기: 새로고침해도 같은 화면·같은 위치
  await page.waitForTimeout(1200);
  const g1 = await G(() => ({ screen: window.__G.screen, turn: window.__G.dungeon && window.__G.dungeon.turn, n: window.__G.dungeon && window.__G.dungeon.monsters.length }));
  await page.reload();
  await page.waitForTimeout(500);
  const g2 = await G(() => ({ screen: window.__G.screen, turn: window.__G.dungeon && window.__G.dungeon.turn, n: window.__G.dungeon && window.__G.dungeon.monsters.length }));
  assert.deepStrictEqual(g2, g1, 'resume after reload');
  await shot('9-resumed');

  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no console errors');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
