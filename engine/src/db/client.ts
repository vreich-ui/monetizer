import pg from 'pg'

/**
 * Thin Db interface so stores never touch the pool directly and the backing
 * client can be swapped (or wrapped for tests) without touching call sites.
 */
export interface Db {
  query<R = any>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number }>
  /** Run fn within a transaction on a dedicated connection. */
  tx<T>(fn: (q: Db) => Promise<T>): Promise<T>
  close(): Promise<void>
}

export function createDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 10 })

  const wrap = (runner: pg.Pool | pg.PoolClient): Db => ({
    async query(text, params) {
      const res = await runner.query(text, params as any[])
      return { rows: res.rows, rowCount: res.rowCount ?? 0 }
    },
    async tx(fn) {
      if (runner !== pool) return fn(wrap(runner)) // already in a tx: join it
      const client = await pool.connect()
      try {
        await client.query('begin')
        const out = await fn(wrap(client))
        await client.query('commit')
        return out
      } catch (err) {
        await client.query('rollback')
        throw err
      } finally {
        client.release()
      }
    },
    async close() {
      if (runner === pool) await pool.end()
    },
  })

  return wrap(pool)
}
