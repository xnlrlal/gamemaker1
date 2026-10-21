// Node 에서 브라우저용 소스를 그대로 불러온다(전역 DS 에 등록).
const path = require('path');
const root = path.join(__dirname, '..', '..');
const order = ['rng', 'entities', 'combat', 'world', 'tactics', 'game', 'icons'];
for (const f of order) require(path.join(root, 'web', 'src', f + '.js'));
// 고정값은 SQLite DB 에서 읽는다(내보내기 로직은 scripts/db_tool.py 한 곳).
const { execFileSync } = require('child_process');
globalThis.DS.db = JSON.parse(execFileSync('python3', [path.join(root, 'scripts', 'db_tool.py'), 'export'],
  { encoding: 'utf8', maxBuffer: 1 << 26 }));
module.exports = globalThis.DS;
