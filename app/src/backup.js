// Copia consistente de la base (VACUUM INTO, seguro con la app andando) y de los catálogos.
// Uso (desde scripts/backup.sh): node src/backup.js /backup
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { settings } from './settings.js';

const outDir = process.argv[2] || '/backup';
fs.mkdirSync(outDir, { recursive: true });

const dbPath = path.join(settings.dataDir, 'news.db');
const target = path.join(outDir, 'news.db');
fs.rmSync(target, { force: true });
if (fs.existsSync(dbPath)) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  db.close();
}
for (const f of ['channels.json', 'feeds.json']) {
  const src = path.join(settings.dataDir, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(outDir, f));
}
console.log(`Backup listo en ${outDir}: ${fs.readdirSync(outDir).join(', ')}`);
