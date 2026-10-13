/* 전투 코어 (기획서 4장). sim/combat.py 의 JS 포팅 — 규칙·수치는 DS.db 에서만 읽는다.
 * 전투 상태는 순수 JSON 이라 전투 도중에도 저장·복원된다(기획서 2-2). */
const DS = (globalThis.DS = globalThis.DS || {});

DS.newCombat = function (allies, enemy, seed, policies) {
  return {
    round: 0, allies, enemy, rng: DS.newRng(seed), log: [],
    result: null, instakill: false, policies: policies || {},
  };
};

function log(state, msg) { state.log.push('R' + state.round + ' ' + msg); }
const eff = (c, s) => DS.effStat(c, s);
const rnd = (state) => DS.rand(state.rng);
const f1 = (x) => (Math.round(x * 10) / 10).toFixed(1);

// ------------------------------------------------------------ 스킬 사용 가능 / 정책
DS.skillUsable = function (state, actor, sid) {
  const s = DS.db.skills[sid];
  return (actor.cooldowns[sid] || 0) <= 0 && actor.spirit >= s.cost;
};

DS.usableSkills = function (state, actor) {
  return actor.skills.filter((sid) => DS.skillUsable(state, actor, sid));
};

/** 정책이 스킬을 비교하는 값: 공격은 위력(근력 반영), 방어는 방어막 두께. */
DS.skillValue = function (state, actor, sid) {
  const rules = DS.db.rules;
  const s = DS.db.skills[sid];
  if (s.kind === 'attack') return s.power * (1 + eff(actor, 'strength') * rules.damage.per_strength);
  return s.shield_base + eff(actor, 'phys_res') * s.shield_per_phys_res;
};

function bestBy(state, actor, filter) {
  let best = null, bestV = -1;
  for (const sid of DS.usableSkills(state, actor)) {
    if (filter && !filter(DS.db.skills[sid])) continue;
    const v = DS.skillValue(state, actor, sid);
    if (v > bestV) { best = sid; bestV = v; }
  }
  return best;
}

DS.POLICIES = {
  highest_value: (st, a) => bestBy(st, a),
  attack_only: (st, a) => bestBy(st, a, (s) => s.kind === 'attack'),
  random: (st, a) => { const o = DS.usableSkills(st, a); return o.length ? DS.choice(st.rng, o) : null; },
  guard_when_hurt: (st, a) => {
    if (a.hp < a.max_hp * DS.db.rules.ai.guard_hp_threshold) {
      for (const sid of DS.usableSkills(st, a)) if (DS.db.skills[sid].kind === 'defend') return sid;
    }
    return DS.POLICIES.attack_only(st, a);
  },
};
DS.DEFAULT_POLICY = 'highest_value';

DS.chooseSkill = function (state, actor) {
  const name = state.policies[actor.id] || actor.ai || DS.DEFAULT_POLICY;
  return DS.POLICIES[name](state, actor);
};

// ------------------------------------------------------------ 피해 / 상태이상
function kill(state, c) {
  c.hp = 0;
  if (c.humanoid && !c.is_player) c.incapacitated = true; // 인간형 NPC 는 죽지 않고 전투불능
  c.alive = false;
  log(state, c.name + ' ' + (c.incapacitated ? '전투불능' : '쓰러짐'));
}

function loseHp(state, c, amount) {
  c.hp -= amount;
  if (c.hp <= 0 && c.alive) kill(state, c);
}

DS.absorbWithShield = function (c, dmg) {
  if (c.shield <= 0) return dmg;
  const absorbed = Math.min(c.shield, dmg);
  c.shield -= absorbed;
  return dmg - absorbed;
};

DS.applyStatus = function (state, target, sid, stacks, duration) {
  const rules = DS.db.rules.status;
  if (sid === 'stun') {
    const res = DS.clamp(eff(target, rules.stun.resist_stat) * rules.stun.resist_per_point, 0, rules.stun.max_resist);
    if (rnd(state) < res) { log(state, target.name + ' 기절 저항'); return; }
    target.stunned = true;
    log(state, target.name + ' 기절');
    return;
  }
  const cfg = rules[sid];
  const cur = target.status[sid];
  if (!cur) target.status[sid] = { stacks: Math.min(stacks, cfg.stack_cap), duration };
  else {
    cur.stacks = Math.min(cur.stacks + stacks, cfg.stack_cap);
    cur.duration = Math.max(cur.duration, duration); // 합산이 아니라 긴 쪽
  }
  log(state, target.name + ' ' + (DS.db.status_names[sid] || sid) + ' x' + target.status[sid].stacks);
};

function damagePart(state, defender) {
  const pd = DS.db.rules.part_damage;
  if (rnd(state) >= pd.chance) return;
  const free = pd.parts.filter((p) => !defender.damaged_parts.includes(p));
  if (!free.length) return;
  const part = DS.choice(state.rng, free);
  defender.damaged_parts.push(part);
  const e = pd.effects[part];
  defender.part_penalty[e.stat] = (defender.part_penalty[e.stat] || 0) + e.delta;
  const slot = pd.gear_slot[part];
  if (slot) {
    for (const item of defender.gear) {
      if (item.slot === slot && item.durability !== null && item.durability > 0) {
        item.durability = Math.max(0, item.durability - pd.durability_loss);
        if (item.durability === 0) log(state, item.name + ' 파손(사라짐)');
      }
    }
  }
  log(state, defender.name + ' 부위 손상: ' + (DS.db.part_names[part] || part));
}

// ------------------------------------------------------------ 공격 판정
DS.hitChance = function (att, def) {
  const h = DS.db.rules.hit;
  const p = h.base + eff(att, 'accuracy') * h.per_accuracy - eff(def, 'flexibility') * h.per_flexibility
    - eff(def, 'stealth') * h.per_stealth;
  return DS.clamp(p, h.min, h.max);
};
DS.critChance = function (att) {
  const c = DS.db.rules.crit;
  return Math.min(c.max, c.base + eff(att, 'flexibility') * c.per_flexibility);
};
DS.critMultiplier = function (att) {
  const c = DS.db.rules.crit;
  return Math.min(c.mult_max, c.mult_base + eff(att, 'obsession') * c.mult_per_obsession);
};
DS.instakillChance = function (att) {
  const ik = DS.db.rules.instakill;
  if (att.grade === null) return 0;
  let p = (ik.base_grade - att.grade) * ik.per_grade_step;
  if (att.ranged) p += ik.ranged_bonus;
  return Math.min(ik.cap, Math.max(0, p));
};
DS.mitigation = function (def) {
  const m = DS.db.rules.mitigation;
  return DS.clamp(eff(def, 'phys_res') * m.per_phys_res, 0, m.cap);
};

DS.resolveAttack = function (state, att, def, sid) {
  const rules = DS.db.rules;
  const skill = DS.db.skills[sid];
  if (rnd(state) >= DS.hitChance(att, def)) {
    log(state, att.name + ' ' + skill.name_ko + ' → ' + def.name + ' 회피');
    state.last = { kind: 'miss', target: def.id };
    return;
  }
  const crit = rnd(state) < DS.critChance(att);
  if (def.is_player && att.grade !== null) {
    const p = DS.instakillChance(att);
    if (p > 0 && rnd(state) < p) {
      state.instakill = true;
      log(state, att.name + ' 헤드샷 즉사!');
      kill(state, def);
      state.last = { kind: 'instakill', target: def.id };
      return;
    }
  }
  let dmg = skill.power * (1 + eff(att, 'strength') * rules.damage.per_strength);
  if (crit) dmg *= DS.critMultiplier(att);
  dmg = Math.max(rules.damage.min_damage, dmg * (1 - DS.mitigation(def)));
  dmg = DS.absorbWithShield(def, dmg);
  log(state, att.name + ' ' + skill.name_ko + ' → ' + def.name + ' ' + (crit ? '치명타 ' : '') + f1(dmg));
  state.last = { kind: 'hit', target: def.id, dmg, crit };
  if (dmg > 0) loseHp(state, def, dmg);
  if (!def.alive) return;
  for (const e of skill.on_hit || []) {
    if (rnd(state) >= (e.chance === undefined ? 1 : e.chance)) continue;
    DS.applyStatus(state, def, e.status, e.stacks || 1, e.duration || 1);
  }
  damagePart(state, def);
};

DS.pickTarget = function (state, actor) {
  if (actor.side === 'ally') return state.enemy;
  const alive = state.allies.filter((a) => a.alive);
  return DS.choice(state.rng, alive); // 생존한 아군 전원에게 균등 무작위(4-12)
};

DS.doAction = function (state, actor, sid) {
  const skill = DS.db.skills[sid];
  actor.spirit -= skill.cost;
  // 쿨타임 N(>=1) = 사용 후 N라운드 동안 사용 불가(라운드 종료 때 1 깎이므로 +1). 0 이면 제한 없음.
  actor.cooldowns[sid] = skill.cooldown > 0 ? skill.cooldown + 1 : 0;
  if (skill.kind === 'defend') {
    const amount = skill.shield_base + eff(actor, 'phys_res') * skill.shield_per_phys_res;
    actor.shield += amount;
    log(state, actor.name + ' ' + skill.name_ko + ' 방어막 ' + f1(amount));
    state.last = { kind: 'shield', target: actor.id, amount };
    return;
  }
  DS.resolveAttack(state, actor, DS.pickTarget(state, actor), sid);
};

// ------------------------------------------------------------ 라운드 진행
DS.checkResult = function (state) {
  if (!state.allies[0].alive) state.result = 'defeat';
  else if (!state.enemy.alive) state.result = 'victory';
  return state.result;
};

DS.actionCount = function (actor) {
  const a = DS.db.rules.actions;
  actor.action_gauge += eff(actor, 'agility') * a.extra_per_agility;
  const extra = Math.floor(actor.action_gauge + 1e-9);
  actor.action_gauge -= extra;
  return Math.min(a.cap, a.base + extra);
};

DS.takeTurn = function (state, actor, forcedSkill) {
  if (!actor.alive || state.result) return;
  actor.shield = 0; // 방어막은 다음 자기 턴 시작까지 유지 [임시 규칙]
  if (actor.stunned) {
    actor.stunned = false;
    log(state, actor.name + ' 기절로 행동 불가');
    return;
  }
  const n = DS.actionCount(actor);
  for (let i = 0; i < n; i++) {
    const sid = i === 0 && forcedSkill ? forcedSkill : DS.chooseSkill(state, actor);
    if (!sid || !DS.skillUsable(state, actor, sid)) break;
    DS.doAction(state, actor, sid);
    if (DS.checkResult(state)) return;
  }
};

DS.endOfRound = function (state) {
  const rules = DS.db.rules;
  const st = rules.status;
  const fighters = state.allies.filter((a) => a.alive).concat(state.enemy.alive ? [state.enemy] : []);
  for (const c of fighters) {
    for (const sid of Object.keys(c.status)) {
      const e = c.status[sid];
      let dmg = e.stacks * st[sid].damage_per_stack;
      if (sid === 'poison') {
        dmg *= Math.max(st.poison.min_factor, 1 - eff(c, st.poison.resist_stat) * st.poison.resist_per_point);
      }
      if (c.alive) {
        log(state, c.name + ' ' + (DS.db.status_names[sid] || sid) + ' 피해 ' + f1(dmg));
        loseHp(state, c, dmg);
      }
      e.duration -= 1;
      if (e.duration <= 0) delete c.status[sid];
    }
  }
  if (DS.checkResult(state)) return;
  for (const c of fighters) {
    if (!c.alive) continue;
    let heal = c.max_hp * rules.regen.pct_of_max_hp_per_point * Math.max(0, eff(c, 'regen'));
    if (c.status.bleed) heal *= rules.regen.bleed_heal_factor;
    c.hp = Math.min(c.max_hp, c.hp + heal);
    c.spirit = Math.min(c.max_spirit, c.spirit + rules.spirit_regen_base + eff(c, 'spirit_regen') * rules.spirit_regen_per_point);
    for (const sid of Object.keys(c.cooldowns)) c.cooldowns[sid] = Math.max(0, c.cooldowns[sid] - 1);
  }
};

/** 한 라운드 진행. playerSkill 을 주면 플레이어의 첫 행동을 수동으로 지정한다. */
DS.runRound = function (state, playerSkill) {
  if (state.result) return state.result;
  state.round += 1;
  for (let i = 0; i < state.allies.length; i++) {
    DS.takeTurn(state, state.allies[i], i === 0 ? playerSkill : null);
    if (state.result) return state.result;
  }
  DS.takeTurn(state, state.enemy);
  if (state.result) return state.result;
  DS.endOfRound(state);
  if (!state.result && state.round >= DS.db.rules.max_rounds) state.result = 'timeout';
  return state.result;
};

DS.runCombat = function (state) {
  while (!state.result) DS.runRound(state);
  return DS.summarize(state);
};

DS.summarize = function (state) {
  return {
    result: state.result, rounds: state.round, player_hp: Math.max(0, state.allies[0].hp),
    instakill: state.instakill, enemy_incapacitated: state.enemy.incapacitated,
  };
};

/** 자동전투용 예상 승률: 같은 규칙으로 모의 전투를 n번 돌린다(4-10). 원본 상태는 건드리지 않는다. */
DS.estimateWinRate = function (state, n) {
  n = n || 200;
  let wins = 0;
  for (let i = 0; i < n; i++) {
    const copy = JSON.parse(JSON.stringify(state));
    copy.rng = DS.newRng((state.rng.s ^ (i * 2654435761)) >>> 0);
    copy.log = [];
    DS.runCombat(copy);
    if (copy.result === 'victory') wins++;
  }
  return wins / n;
};
