// Python 참조 구현(sim/)과 JS 포팅의 승률이 통계적으로 같은지 확인한다.
const { execFileSync } = require('child_process');
const path = require('path');
const DS = require('./load');
const root = path.join(__dirname, '..', '..');
const N = 4000;
const cases = [
  ['barbarian', 'greatsword', 'gnome', 0], ['barbarian', 'greatsword', 'ghoul', 0],
  ['barbarian', 'greatsword', 'ghoul', 2], ['barbarian', 'shield', 'ghoul', 0],
  ['barbarian', 'bow', 'goblin_archer', 0], ['human', 'sword', 'tiger', 0],
  ['elf', 'spear', 'deathfiend', 0], ['dwarf', 'mace', 'skeleton_warrior', 0],
  ['barbarian', 'greatsword', 'wanderer', 0], ['barbarian', 'sword', 'kobold_shield', 0],
];
let failed = 0;
for (const [race, weapon, enemy, mastery] of cases) {
  const py = JSON.parse(execFileSync('python3', ['-m', 'sim.simulate', '--race', race, '--weapon', weapon, '--enemy', enemy,
    '-n', String(N), '--mastery', String(mastery), '--json'], { cwd: root }).toString());
  let wins = 0, rounds = 0;
  for (let i = 0; i < N; i++) {
    const p = DS.makePlayer(race, weapon, { mastery });
    const st = DS.newCombat([p], DS.makeEnemy(enemy), 1000 + i);
    const r = DS.runCombat(st);
    rounds += r.rounds;
    if (r.result === 'victory') wins++;
  }
  const js = { win: wins / N, rounds: rounds / N };
  const dWin = Math.abs(js.win - py.win_rate), dRounds = Math.abs(js.rounds - py.avg_rounds);
  const ok = dWin < 0.035 && dRounds < 0.25;
  if (!ok) failed++;
  console.log((ok ? 'OK  ' : 'FAIL') + ` ${race}/${weapon} vs ${enemy} m${mastery}: win py ${(py.win_rate * 100).toFixed(1)} js ${(js.win * 100).toFixed(1)} | rounds py ${py.avg_rounds.toFixed(2)} js ${js.rounds.toFixed(2)}`);
}
process.exit(failed ? 1 : 0);
