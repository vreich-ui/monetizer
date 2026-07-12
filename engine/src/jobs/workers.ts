import type { Db } from '../db/client.ts'
import type { CredentialBroker } from '../core/credentials.ts'
import type { JobHandler } from './queue.ts'
import { enqueue, ensureSchedule } from './queue.ts'
import { adapterFor, getSource, listSources } from '../adapters/registry.ts'
import { runAttribution } from '../attribution/resolver.ts'
import { setLifecycle } from '../core/offers.ts'
import type { CsvDrop } from '../adapters/types.ts'

export function buildHandlers(broker: CredentialBroker): Map<string, JobHandler> {
  const handlers = new Map<string, JobHandler>()

  handlers.set('catalog_sync', async (db, payload) => {
    const source = await getSource(db, String(payload.source_id))
    if (!source || source.status !== 'active') return
    const adapter = adapterFor(source.network)
    if (!adapter?.syncCatalog) return
    const res = await adapter.syncCatalog({ db, broker }, source)
    await db.query(
      `update sources set health = health || jsonb_build_object('last_catalog_sync', now()::text, 'last_catalog_upserted', $2::int) where id = $1`,
      [source.id, res.upserted],
    )
  })

  handlers.set('poll_reports', async (db, payload) => {
    const source = await getSource(db, String(payload.source_id))
    if (!source || source.status !== 'active') return
    const adapter = adapterFor(source.network)
    if (!adapter?.pollReports) return
    const res = await adapter.pollReports({ db, broker }, source, Number(payload.since_days ?? 45))
    await db.query(
      `update sources set health = health || jsonb_build_object('last_report_poll', now()::text, 'last_observations', $2::int) where id = $1`,
      [source.id, res.observations],
    )
  })

  handlers.set('attribution_run', async (db) => {
    const stats = await runAttribution(db)
    console.log('attribution:', JSON.stringify(stats))
  })

  handlers.set('process_csv_drops', async (db) => {
    const { rows: drops } = await db.query<CsvDrop & { status: string }>(
      `select * from csv_drops where status = 'queued' order by created_at limit 20`,
    )
    for (const drop of drops) {
      const source = await getSource(db, drop.source_id)
      const adapter = source ? adapterFor(source.network) : null
      try {
        if (!source || !adapter?.ingestCsv) throw new Error('source missing or no csv capability')
        const res = await adapter.ingestCsv({ db, broker }, source, drop)
        await db.query(`update csv_drops set status = 'processed', error = null where id = $1`, [drop.id])
        console.log(`csv drop ${drop.id}: processed ${res.processed} rows`)
      } catch (err) {
        await db.query(`update csv_drops set status = 'failed', error = $2 where id = $1`, [
          drop.id,
          String(err).slice(0, 2000),
        ])
      }
    }
  })

  // Liveness (docs/plan/03): sample active offers, HEAD their destinations,
  // mark dead links; failover at the redirect covers the gap until rebuild.
  handlers.set('liveness_check', async (db) => {
    const { rows: offers } = await db.query<{ id: string; tracking: { destination_url?: string } }>(
      `select id, tracking from offers
        where lifecycle = 'active' and tracking->>'destination_url' is not null
        order by random() limit 25`,
    )
    for (const o of offers) {
      const url = o.tracking.destination_url
      if (!url) continue
      try {
        const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(8000) })
        if (res.status === 404 || res.status === 410) {
          await setLifecycle(db, o.id, 'dead', `liveness: HTTP ${res.status}`)
        }
      } catch {
        await setLifecycle(db, o.id, 'stale', 'liveness: unreachable')
      }
    }
  })

  // Rebuild trigger (docs/plan/02): debounced via dedupe + delayed run_at.
  handlers.set('rebuild_tenant', async (db, payload) => {
    const { rows } = await db.query<{ netlify_build_hook_url: string | null; slug: string }>(
      `select netlify_build_hook_url, slug from tenants where id = $1`,
      [String(payload.tenant_id)],
    )
    const hook = rows[0]?.netlify_build_hook_url
    if (!hook) return
    const res = await fetch(hook, { method: 'POST' })
    console.log(`rebuild ${rows[0]?.slug}: HTTP ${res.status}`)
  })

  return handlers
}

/** Default recurring schedule set; report polling fans out per source. */
export async function seedSchedules(db: Db): Promise<void> {
  await ensureSchedule(db, 'attribution_run', 3600)
  await ensureSchedule(db, 'process_csv_drops', 300)
  await ensureSchedule(db, 'liveness_check', 6 * 3600)
  await ensureSchedule(db, 'poll_all_reports', 6 * 3600)
  await ensureSchedule(db, 'sync_all_catalogs', 24 * 3600)
}

export function addFanoutHandlers(handlers: Map<string, JobHandler>): void {
  handlers.set('poll_all_reports', async (db) => {
    for (const s of await listSources(db)) {
      if (s.status === 'active' && s.capabilities?.reporting?.transactions === 'api') {
        await enqueue(db, 'poll_reports', { source_id: s.id }, { dedupe: true })
      }
    }
  })
  handlers.set('sync_all_catalogs', async (db) => {
    for (const s of await listSources(db)) {
      if (s.status === 'active' && (s.capabilities?.catalog?.search || s.capabilities?.catalog?.feed)) {
        await enqueue(db, 'catalog_sync', { source_id: s.id }, { dedupe: true })
      }
    }
  })
}
