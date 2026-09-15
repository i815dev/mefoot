import pg from 'pg';
import { readFileSync } from 'node:fs';
import { checkServerIdentity } from 'node:tls';

export interface QueryExecutor {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}
export interface Database extends QueryExecutor {
  transaction<T>(fn: (tx: QueryExecutor) => Promise<T>): Promise<T>;
}
export function databaseFromPool(pool: pg.Pool): Database {
  return {
    query: (sql, params) => pool.query(sql, params),
    async transaction<T>(fn: (tx: QueryExecutor) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '5s'");
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    },
  };
}
export function createPool(env: NodeJS.ProcessEnv = process.env): pg.Pool {
  if (!env.PGHOST || !env.PGUSER || !env.PGPASSWORD || !env.PGDATABASE)
    throw new Error('PostgreSQL connection settings missing');
  if (!env.PGSSLROOTCERT) throw new Error('PGSSLROOTCERT is required');
  return new pg.Pool({
    host: env.PGHOST, port: Number(env.PGPORT || 5432), user: env.PGUSER,
    password: env.PGPASSWORD, database: env.PGDATABASE,
    ssl: { ca: readFileSync(env.PGSSLROOTCERT, 'utf8'), rejectUnauthorized: true,
      // pg sets SNI to its Docker hostname. Validate the certificate against
      // the explicitly configured public DB identity, without disabling TLS checks.
      checkServerIdentity: (_hostname, certificate) => checkServerIdentity(env.PGTLS_SERVERNAME || env.PGHOST!, certificate) },
    max: 5, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000,
    statement_timeout: 30_000, application_name: 'mefoot-api',
  });
}
