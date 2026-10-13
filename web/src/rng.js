/* 시드 가능한 난수(mulberry32). 상태가 숫자 하나라 JSON 저장·복원이 쉽다. */
const DS = (globalThis.DS = globalThis.DS || {});

DS.newRng = function (seed) {
  return { s: (seed >>> 0) || 1 };
};

DS.rand = function (rng) {
  rng.s = (rng.s + 0x6d2b79f5) >>> 0;
  let t = rng.s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

DS.randInt = function (rng, n) {
  return Math.floor(DS.rand(rng) * n);
};

DS.choice = function (rng, arr) {
  return arr[DS.randInt(rng, arr.length)];
};

DS.clamp = function (v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
};
