/* 전투 참가자 생성. 순수 객체(JSON 직렬화 가능). sim/entities.py 와 같은 규칙. */
const DS = (globalThis.DS = globalThis.DS || {});

DS.STAT_DEFAULTS = {
  spirit: 0, body: 0, mind: 0, psychic: 0,
  strength: 0, phys_res: 0, regen: 0, smell: 0,
  accuracy: 0, flexibility: 0, agility: 0, poison_res: 0,
  stealth: 0, obsession: 0, endurance: 0, dexterity: 0, spirit_regen: 0,
};

/** 기본값 + 장비(내구도가 남은 것만) + 손상 부위 + 사냥 숙련(상대 한정). */
DS.effStat = function (c, stat) {
  let v = c.base_stats[stat] || 0;
  for (const item of c.gear) {
    if (item.durability === null || item.durability > 0) v += item.bonuses[stat] || 0;
  }
  v += c.part_penalty[stat] || 0;
  v += c.vs_bonus[stat] || 0;
  return v;
};

DS.newCombatant = function (o) {
  const db = DS.db;
  const stats = Object.assign({}, DS.STAT_DEFAULTS, o.base_stats);
  const c = {
    id: o.id, name: o.name, side: o.side, is_player: !!o.is_player, ai: o.ai || null,
    base_stats: stats, gear: o.gear || [], skills: o.skills.slice(),
    ranged: !!o.ranged, grade: o.grade === undefined ? null : o.grade, humanoid: !!o.humanoid,
    hp: db.rules.max_hp, max_hp: db.rules.max_hp,
    spirit: 0, max_spirit: 0,
    cooldowns: {}, status: {}, stunned: false, shield: 0,
    damaged_parts: [], part_penalty: {}, vs_bonus: {},
    action_gauge: 0, alive: true, incapacitated: false,
  };
  c.max_spirit = DS.effStat(c, 'spirit') * db.rules.spirit_scale;
  c.spirit = c.max_spirit;
  return c;
};

DS.makeGear = function (itemId) {
  const eq = DS.db.equipment;
  const item = eq.weapons[itemId] || eq.armor[itemId];
  return {
    id: itemId, name: item.name_ko, slot: item.slot,
    bonuses: Object.assign({}, item.bonuses),
    durability: item.durability === undefined ? null : item.durability,
    max_durability: item.durability === undefined ? null : item.durability,
    range: item.range || 0,
  };
};

DS.makePlayer = function (race, weaponId, opts) {
  opts = opts || {};
  const db = DS.db;
  const r = db.races[race];
  const gear = [];
  if (weaponId) gear.push(DS.makeGear(weaponId));
  for (const a of (opts.armor || db.equipment.barbarian_starter_armor)) gear.push(DS.makeGear(a));
  const c = DS.newCombatant({
    id: race, name: opts.name || r.name_ko, side: 'ally', is_player: true,
    base_stats: r.stats, gear, skills: opts.skills || db.player_default_skills,
    ranged: weaponId === 'bow', grade: null, humanoid: true,
  });
  DS.applyMastery(c, opts.mastery || 0);
  return c;
};

DS.applyMastery = function (c, level) {
  const m = DS.db.rules.mastery;
  level = Math.max(0, Math.min(level, m.max_level));
  c.vs_bonus = {};
  if (level) for (const k in m.bonus_per_level) c.vs_bonus[k] = m.bonus_per_level[k] * level;
};

DS.monsterStatsFromGrade = function (grade) {
  const g = DS.db.rules.monster_grade;
  const steps = g.base_grade - grade;
  const stats = { strength: steps * g.strength_per_step, phys_res: steps * g.phys_res_per_step };
  if (grade <= g.regen_from_grade) stats.regen = (g.regen_from_grade + 1 - grade) * g.regen_per_step;
  return stats;
};

DS.makeMonster = function (id) {
  const db = DS.db;
  const m = db.monsters[id];
  const stats = Object.assign({}, db.monster_defaults.stats, DS.monsterStatsFromGrade(m.grade), m.stat_override || {});
  return DS.newCombatant({
    id, name: m.name_ko, side: 'enemy', base_stats: stats,
    skills: m.skills || db.monster_defaults.skills, ranged: m.ranged, grade: m.grade,
    humanoid: false, ai: m.ai || db.monster_defaults.ai,
  });
};

DS.makeNpc = function (id) {
  const db = DS.db;
  const n = db.npcs[id];
  return DS.newCombatant({
    id, name: n.name_ko, side: 'enemy', base_stats: n.stats, skills: n.skills,
    ranged: n.ranged, grade: null, humanoid: n.humanoid, ai: n.ai || db.monster_defaults.ai,
  });
};

DS.makeEnemy = function (id) {
  return DS.db.monsters[id] ? DS.makeMonster(id) : DS.makeNpc(id);
};
