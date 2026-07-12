import { readdir, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Db } from './client.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations')

export async function migrate(db: Db): Promise<string[]> {
  await db.query(`create table if not exists _migrations (
    name text primary key, applied_at timestamptz not null default now())`)
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()
  const { rows } = await db.query<{ name: string }>('select name from _migrations')
  const done = new Set(rows.map((r) => r.name))
  const applied: string[] = []
  for (const file of files) {
    if (done.has(file)) continue
    const sql = await readFile(join(migrationsDir, file), 'utf8')
    await db.tx(async (q) => {
      await q.query(sql)
      await q.query('insert into _migrations (name) values ($1)', [file])
    })
    applied.push(file)
  }
  return applied
}
