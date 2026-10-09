'use strict';
// Check inline <script> (no src) blocks in public HTML files for syntax errors.
const fs = require('fs');
const vm = require('vm');
let failed = false;
for (const f of ['public/dashboard.html', 'public/admin/dashboard.html', 'public/register.html']) {
  const s = fs.readFileSync(f, 'utf8');
  const re = /<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g;
  let m, n = 0;
  while ((m = re.exec(s))) {
    try { new vm.Script(m[1]); n++; } catch (e) { console.error('SYNTAX ERR', f, e.message); failed = true; }
  }
  console.log(f, '->', n, 'script block(s) OK');
}
process.exit(failed ? 1 : 0);