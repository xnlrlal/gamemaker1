// Node 에서 브라우저용 소스를 그대로 불러온다(전역 DS 에 등록).
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const order = ['rng', 'entities', 'combat', 'world', 'game', 'icons'];
for (const f of order) require(path.join(root, 'web', 'src', f + '.js'));
globalThis.DS.db = JSON.parse(fs.readFileSync(path.join(root, 'data', 'db.json'), 'utf8'));
module.exports = globalThis.DS;
