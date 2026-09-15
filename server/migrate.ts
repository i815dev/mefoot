import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createPool, databaseFromPool } from './db.ts';
import type { Database } from './db.ts';

export async function migrate(db: Database): Promise<string[]> {
  const folder = fileURLToPath(new URL('../database/migrations/', import.meta.url));
  const files = (await readdir(folder)).filter(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
  return db.transaction(async tx => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('mefoot-schema-migrations'))");
    await tx.query(`CREATE TABLE IF NOT EXISTS mefoot.schema_migrations (
      version text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied: string[] = [];
    for (const file of files) {
      const sql = await readFile(resolve(folder, file), 'utf8');
      const sha = createHash('sha256').update(sql).digest('hex');
      const prior = await tx.query('SELECT sha256 FROM mefoot.schema_migrations WHERE version=$1', [file]);
      if (prior.rows.length) {
        if (prior.rows[0].sha256 !== sha) throw new Error(`Migration checksum differs: ${file}`);
        continue;
      }
      await tx.query(sql);
      await tx.query('INSERT INTO mefoot.schema_migrations(version,sha256) VALUES($1,$2)', [file, sha]);
      applied.push(file);
    }
    return applied;
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pool = createPool();
  try { console.log(JSON.stringify({ applied: await migrate(databaseFromPool(pool)) })); }
  finally { await pool.end(); }
}
