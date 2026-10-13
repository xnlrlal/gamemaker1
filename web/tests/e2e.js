// 브라우저(실제 크로미움)에서 한 판 루프를 끝까지 돌려 본다. 사용법: node web/tests/e2e.js [스크린샷 폴더]
const { chromium } = require('playwright');
const path = require('path');
const assert = require('assert');
const shots = process.argv[2] || '/tmp';
const url = 'file://' + path.join(__dirname, '..', 'dist', 'play.html');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  const shot = (n) => page.screenshot({ path: path.join(shots, n + '.png') });
  const screen = () => page.evaluate(() => window.__G.screen);

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

  // 꾹 누르기: D패드를 길게 눌러도 글자가 선택되지 않고 계속 걷는다
  const noSelect = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('.dpad .right'));
    return cs.userSelect === 'none' && getComputedStyle(document.getElementById('map')).userSelect === 'none';
  });
  assert.ok(noSelect, 'user-select none on map controls');
  await page.evaluate(() => { window.__enc = DS.db.dungeon.floor1.encounter_chance; DS.db.dungeon.floor1.encounter_chance = 0; }); // 이 구간은 조우 없이
  const dp = await page.locator('.dpad .right').boundingBox();
  const p0 = await page.evaluate(() => JSON.stringify(window.__G.dungeon.pos));
  await page.mouse.move(dp.x + dp.width / 2, dp.y + dp.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(900);
  const selected = await page.evaluate(() => String(window.getSelection()));
  await page.mouse.up();
  assert.strictEqual(selected, '', 'long press must not select text');
  const p1 = await page.evaluate(() => JSON.stringify(window.__G.dungeon.pos));
  assert.notStrictEqual(p1, p0, 'held D-pad keeps walking');

  // 지도 탭으로 걷기: 시작점에서 보이는 열린 칸 하나를 탭한다
  const before = await page.evaluate(() => JSON.stringify(window.__G.dungeon.pos));
  const target = await page.evaluate(() => {
    const G = window.__G, f = DS.getFloor(), p = G.dungeon.pos;
    for (let r = 3; r >= 1; r--) for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r]]) {
      const path = DS.findPath(f, p, { x: p.x + dx, y: p.y + dy });
      if (path && path.length) return { dx, dy };
    }
    return null;
  });
  assert.ok(target, 'walkable tile near start');
  const box = await page.locator('#map').boundingBox();
  const ts = 44; // 지도 타일 한 칸의 CSS 픽셀 크기
  await page.touchscreen.tap(box.x + box.width / 2 + target.dx * ts, box.y + box.height / 2 + target.dy * ts);
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => JSON.stringify(window.__G.dungeon.pos));
  assert.notStrictEqual(after, before, 'player moved after tap');

  // 소지품·캐릭터 창을 열고 닫는다
  await page.click('button[aria-label="소지품"]');
  await page.waitForSelector('.win-title:has-text("소지품")');
  await page.click('button[aria-label="대검"]');
  await shot('4b-inventory');
  await page.click('.win-x');
  await page.click('button[aria-label="캐릭터"]');
  await page.waitForSelector('.win-title:has-text("캐릭터")');
  await shot('4c-character');
  await page.click('.win-x');

  // 조우가 날 때까지 걷게 한다(규칙 함수 직접 호출) → 화면 갱신
  await page.evaluate(() => {
    DS.db.dungeon.floor1.encounter_chance = window.__enc;
    const G = window.__G, f = DS.getFloor();
    let dir = 0;
    for (let i = 0; i < 20000 && G.screen === 'dungeon'; i++) {
      const { x, y } = G.dungeon.pos;
      for (let t = 0; t < 4; t++) {
        const [dx, dy] = DS.DIRS[(dir + t) % 4];
        if (DS.isOpen(f, x + dx, y + dy)) { dir = (dir + t) % 4; DS.stepTo(G, x + dx, y + dy); break; }
      }
      if (G.rng.s % 5 === 0) dir = (dir + 1) % 4;
    }
    DS.uiRender();
  });
  assert.strictEqual(await screen(), 'battle');
  await shot('5-battle');

  await page.click('button.skill:has-text("강타")');
  await page.waitForTimeout(150);
  await shot('6-battle-after-skill');

  // 자동 전투 켜고 전투가 끝날 때까지
  if ((await screen()) === 'battle') {
    await page.check('#auto-sw');
    await page.waitForFunction(() => window.__G.screen !== 'battle' || !window.__G.auto, null, { timeout: 90000 }).catch(() => {});
    await page.waitForFunction(() => window.__G.screen === 'dungeon' || window.__G.screen === 'dead' || window.__G.screen === 'town', null, { timeout: 90000 });
  }
  const s = await screen();
  console.log('after auto battle screen =', s);
  await shot('7-after-battle');

  // 저장/이어하기: 새로고침해도 같은 화면
  await page.waitForTimeout(1200);
  const g1 = await page.evaluate(() => ({ screen: window.__G.screen, stones: window.__G.char && window.__G.char.stones }));
  await page.reload();
  await page.waitForTimeout(500);
  const g2 = await page.evaluate(() => ({ screen: window.__G.screen, stones: window.__G.char && window.__G.char.stones }));
  assert.deepStrictEqual(g2, g1, 'resume after reload');
  await shot('8-resumed');

  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no console errors');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
