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
  const ts = 40 * (box.width / 480);
  await page.touchscreen.tap(box.x + box.width / 2 + target.dx * ts, box.y + box.height / 2 + target.dy * ts);
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => JSON.stringify(window.__G.dungeon.pos));
  assert.notStrictEqual(after, before, 'player moved after tap');

  // 조우가 날 때까지 걷게 한다(규칙 함수 직접 호출) → 화면 갱신
  await page.evaluate(() => {
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
