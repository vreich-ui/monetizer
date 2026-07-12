import type { Db } from '../db/client.ts'

/**
 * Minimal Postgres job queue (docs/plan/06): FOR UPDATE SKIP LOCKED claims,
 * exponential backoff, recurring schedules. Deliberately boring.
 */

export type JobHandler = (db: Db, payload: Record<string, unknown>) => Promise<void>

export interface JobRow {
  id: string
  kind: string
  payload: Record<string, unknown>
  attempts: number
  max_attempts: number
}

export async function enqueue(
  db: Db,
  kind: string,
  payload: Record<string, unknown> = {},
  opts: { runAt?: Date; dedupe?: boolean } = {},
): Promise<void> {
  if (opts.dedupe) {
    const { rows } = await db.query(
      `select 1 from jobs where kind = $1 and payload = $2::jsonb and status = 'queued' limit 1`,
      [kind, JSON.stringify(payload)],
    )
    if (rows.length > 0) return
  }
  await db.query(`insert into jobs (kind, payload, run_at) values ($1, $2, $3)`, [
    kind,
    JSON.stringify(payload),
    opts.runAt ?? new Date(),
  ])
}

export async function claimAndRun(db: Db, handlers: Map<string, JobHandler>): Promise<boolean> {
  const job = await db.tx(async (q) => {
    const { rows } = await q.query<JobRow>(
      `select id, kind, payload, attempts, max_attempts from jobs
        where status = 'queued' and run_at <= now()
        order by run_at
        for update skip locked
        limit 1`,
    )
    const j = rows[0]
    if (!j) return null
    await q.query(`update jobs set status = 'running', locked_at = now(), attempts = attempts + 1 where id = $1`, [j.id])
    return j
  })
  if (!job) return false

  const handler = handlers.get(job.kind)
  try {
    if (!handler) throw new Error(`no handler for job kind '${job.kind}'`)
    await handler(db, job.payload)
    await db.query(`update jobs set status = 'done' where id = $1`, [job.id])
  } catch (err) {
    const failed = job.attempts + 1 >= job.max_attempts
    const backoffS = Math.min(3600, 30 * 2 ** job.attempts)
    await db.query(
      `update jobs set status = $2, last_error = $3,
         run_at = now() + ($4 || ' seconds')::interval
       where id = $1`,
      [job.id, failed ? 'failed' : 'queued', String(err).slice(0, 2000), String(backoffS)],
    )
    console.error(`job ${job.kind}#${job.id} attempt ${job.attempts + 1} failed:`, err)
  }
  return true
}

/** Fire due schedules by enqueueing their job kinds, then advance next_at. */
export async function tickSchedules(db: Db): Promise<void> {
  const { rows } = await db.query<{ kind: string; interval_s: number; payload: Record<string, unknown> }>(
    `update schedules set next_at = now() + (interval_s || ' seconds')::interval
      where enabled and next_at <= now()
      returning kind, interval_s, payload`,
  )
  for (const s of rows) await enqueue(db, s.kind, s.payload, { dedupe: true })
}

export async function ensureSchedule(
  db: Db,
  kind: string,
  intervalS: number,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    `insert into schedules (kind, interval_s, payload) values ($1,$2,$3)
     on conflict (kind) do update set interval_s = excluded.interval_s`,
    [kind, intervalS, JSON.stringify(payload)],
  )
}

export function startWorker(
  db: Db,
  handlers: Map<string, JobHandler>,
  opts: { pollMs?: number } = {},
): () => void {
  const pollMs = opts.pollMs ?? 2000
  let stopped = false
  let draining = false
  const loop = async () => {
    if (stopped || draining) return
    draining = true
    try {
      await tickSchedules(db)
      // Drain until empty, then sleep.
      while (!stopped && (await claimAndRun(db, handlers))) {
        /* keep claiming */
      }
    } catch (err) {
      console.error('worker loop error', err)
    } finally {
      draining = false
    }
  }
  const timer = setInterval(loop, pollMs)
  void loop()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
