import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'sql');

export async function migrate() {
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
        await pool.query(readFileSync(join(dir, f), 'utf8'));
    }
}

// Executado diretamente: npm run migrate
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    migrate()
        .then(() => { console.log('Migração concluída'); return pool.end(); })
        .catch((e) => { console.error(e); process.exit(1); });
}
