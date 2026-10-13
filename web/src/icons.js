/* 직접 그린 벡터 아이콘(24x24 격자). 색은 CSS 의 currentColor / --icon-* 토큰을 따른다.
 * 외부 게임의 이미지·아이콘을 가져다 쓰지 않는다. */
const DS = (globalThis.DS = globalThis.DS || {});

const I = {
  // 스킬
  slash: '<path d="M5 19 19 5" stroke-width="2.4"/><path d="M15 3.5 20.5 9" stroke-width="2"/><path d="m4 20 2.5-1.5" stroke-width="3"/>',
  smash: '<path d="M6 20 15 11" stroke-width="2.6"/><rect x="11" y="3.5" width="9" height="6.5" rx="1" transform="rotate(45 15.5 6.75)" class="f"/>',
  guard: '<path d="M12 3 20 6v6c0 4.5-3.4 7.7-8 9-4.6-1.3-8-4.5-8-9V6z" class="f"/><path d="M12 6v12" stroke-width="1.4" class="cut"/>',
  pierce: '<path d="M4 20 17 7" stroke-width="2.2"/><path d="m14 4 6-.5L19.5 10z" class="f"/><path d="m4 20 2-.5" stroke-width="3"/>',
  // 무기
  spear: '<path d="M5 20 17 8" stroke-width="2"/><path d="M15 4.5 20.5 3.5 19.5 9z" class="f"/>',
  sword: '<path d="M6 18 18 6" stroke-width="2.6"/><path d="m6.5 12.5 5 5" stroke-width="2.2"/><path d="m5 19-1.5 1.5" stroke-width="3"/>',
  mace: '<path d="M6 19 14 11" stroke-width="2.4"/><circle cx="16" cy="8" r="4.2" class="f"/><path d="M16 2.5v1.5M21.5 8H20M16 12v1.5M10.5 8H12" stroke-width="1.6"/>',
  shield: '<path d="M12 3 20 6v6c0 4.5-3.4 7.7-8 9-4.6-1.3-8-4.5-8-9V6z" class="f"/><circle cx="12" cy="11.5" r="2.4" class="cut"/>',
  greatsword: '<path d="M5 19 19 5" stroke-width="3.4"/><path d="m5.5 11.5 7 7" stroke-width="2.4"/><path d="m4 20 1.5-1.5" stroke-width="3"/>',
  bow: '<path d="M7 3c8 3 8 15 0 18" stroke-width="2.2"/><path d="M7 3v18" stroke-width="1" /><path d="M7 12h12m-3-3 3 3-3 3" stroke-width="1.6"/>',
  // 방어구
  top: '<path d="M8 4 4 7l2 4 2-1v10h8V10l2 1 2-4-4-3-2 2h-4z" class="f"/>',
  bottom: '<path d="M7 4h10l1 16h-4.5L12 11l-1.5 9H6z" class="f"/>',
  shoes: '<path d="M5 11h6l1 4 7 1.5V20H5z" class="f"/>',
  // 아이템
  gem: '<path d="m12 3 7 6-7 12L5 9z" class="f"/><path d="M5 9h14M9.5 9 12 21l2.5-12M9.5 9 12 3l2.5 6" stroke-width="1" class="cut"/>',
  coin: '<circle cx="12" cy="12" r="8.5" class="f"/><circle cx="12" cy="12" r="5.2" class="cut" stroke-width="1.4"/>',
  essence: '<path d="M12 3c4 4.5 6 7.3 6 10.3a6 6 0 0 1-12 0C6 10.300 8 7.500 12 3z" class="f"/>',
  // 메뉴
  bag: '<path d="M8 8V6.500a4 4 0 0 1 8 0V8" stroke-width="1.8"/><path d="M5 8h14l1 12H4z" class="f"/><path d="M9 13h6" stroke-width="1.6" class="cut"/>',
  person: '<circle cx="12" cy="7" r="3.5" class="f"/><path d="M5 21c0-5 3-8 7-8s7 3 7 8z" class="f"/>',
  scroll: '<path d="M6 5h12v13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2z" class="f"/><path d="M9 9h6M9 12h6M9 15h4" stroke-width="1.4" class="cut"/>',
  gear: '<circle cx="12" cy="12" r="3" stroke-width="2"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.600 5.600l2.100 2.100M16.300 16.300l2.100 2.100M5.600 18.400l2.100-2.100M16.300 7.700l2.100-2.100" stroke-width="2.2"/>',
  map: '<path d="M3 6.500 9 4l6 2.500L21 4v13.500L15 20l-6-2.500L3 20z" class="f"/><path d="M9 4v13.500M15 6.500V20" stroke-width="1.2" class="cut"/>',
  lock: '<rect x="6" y="11" width="12" height="9" rx="1.500" class="f"/><path d="M8.500 11V8a3.500 3.500 0 0 1 7 0v3" stroke-width="1.800"/>',
  skull: '<path d="M12 3a7.500 7.500 0 0 0-5 13v3h3v-2h4v2h3v-3a7.500 7.500 0 0 0-5-13z" class="f"/><circle cx="9.200" cy="11" r="1.600" class="cut"/><circle cx="14.800" cy="11" r="1.600" class="cut"/>',
  drop: '<path d="M12 3c4 5 6 7.500 6 10.500a6 6 0 0 1-12 0C6 10.500 8 8 12 3z" class="f"/>',
  bolt: '<path d="m13 2-8 12h6l-1 8 8-12h-6z" class="f"/>',
  claw: '<path d="M6 20C5 13 7 7 10 3M12 21c-1-7 0-12 3-17M18 20c0-6 1-10 3-14" stroke-width="2.2"/>',
  fang: '<path d="M5 6h14c0 6-2 9-4 13-1-2-1-4-3-4s-2 2-3 4C7 15 5 12 5 6z" class="f"/>',
};

DS.iconSvg = function (name) {
  return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">' + (I[name] || I.gem) + '</svg>';
};

/** 스킬 id → 아이콘 이름 */
DS.skillIcon = function (sid) {
  return { slash: 'slash', smash: 'smash', guard: 'guard', pierce: 'pierce', bite: 'fang', rend: 'claw', shoot: 'bow',
    aimed_shot: 'bow', shield_bash: 'shield', spirit_bolt: 'bolt', wail: 'skull' }[sid] || 'slash';
};

/** 아치 부조 띠: 고딕 뾰족 아치가 줄지어 선 장식(창 위·아래). */
DS.archBand = function (count) {
  const w = 100 / count;
  let p = '';
  for (let i = 0; i < count; i++) {
    const x = i * w + w * 0.14, r = w * 0.72;
    const a = x, b = x + r, m = x + r / 2;
    p += '<path d="M' + a + ' 40V16Q' + a + ' 6 ' + m + ' 2Q' + b + ' 6 ' + b + ' 16V40Z" class="niche"/>' +
      '<path d="M' + (a + r * 0.18) + ' 40V18Q' + (a + r * 0.18) + ' 11 ' + m + ' 8Q' + (b - r * 0.18) + ' 11 ' + (b - r * 0.18) + ' 18V40Z" class="niche2"/>';
  }
  return '<svg class="arches" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">' + p + '</svg>';
};
