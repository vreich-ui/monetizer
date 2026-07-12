import { Hono } from 'hono'
import { z } from 'zod'
import type { Db } from '../db/client.ts'
import { appendEvent } from '../core/events.ts'
import { visitorHash, ivtSignals } from './redirect.ts'

const beaconBody = z.object({
  tenant: z.string().max(120).optional(),
  page: z.string().max(500),
  events: z
    .array(
      z.object({
        type: z.enum(['pageview', 'impression', 'viewable']),
        decision_id: z.string().max(40).optional(),
        surface_id: z.string().max(60).optional(),
        t: z.number().optional(),
      }),
    )
    .max(100),
})

export function beaconRoutes(deps: { db: Db; hashSalt: string }): Hono {
  const app = new Hono()

  app.post('/v1/beacon', async (c) => {
    const parsed = beaconBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.body(null, 204) // beacons never error loudly
    const ua = c.req.header('user-agent') ?? ''
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? '0.0.0.0'
    const vh = visitorHash(deps.hashSalt, ip, ua)
    const ivt = ivtSignals(ua)

    for (const e of parsed.data.events) {
      let tenantId: string | null = null
      let surfaceId = e.surface_id ?? null
      if (e.decision_id) {
        const { rows } = await deps.db.query<{ tenant_id: string; surface_id: string }>(
          `select tenant_id, surface_id from decisions where id = $1`,
          [e.decision_id],
        )
        tenantId = rows[0]?.tenant_id ?? null
        surfaceId = surfaceId ?? rows[0]?.surface_id ?? null
      }
      void appendEvent(deps.db, {
        type: e.type,
        occurred_at: e.t ? new Date(e.t) : new Date(),
        tenant_id: tenantId,
        surface_id: surfaceId,
        decision_id: e.decision_id ?? null,
        visitor_hash: vh,
        ivt_score: ivt.score,
        ivt_reasons: ivt.reasons.length ? ivt.reasons : null,
        payload: { page: parsed.data.page },
      }).catch(() => {})
    }
    return c.body(null, 204)
  })

  app.get('/beacon.js', (c) => {
    c.header('content-type', 'application/javascript')
    c.header('cache-control', 'public, max-age=86400')
    return c.body(BEACON_JS)
  })

  return app
}

/** Self-hosted, ~1KB, no third-party calls (docs/plan/04 §Denominators). */
const BEACON_JS = `(function(){
var E=[],sent=false,base=document.currentScript&&document.currentScript.dataset.engine||'';
function push(t,d){E.push({type:t,decision_id:d||undefined,t:Date.now()})}
function flush(){if(!E.length)return;var b=JSON.stringify({page:location.pathname,events:E.splice(0,100)});
try{navigator.sendBeacon(base+'/v1/beacon',new Blob([b],{type:'application/json'}))}catch(e){}}
push('pageview');
var els=document.querySelectorAll('[data-mz-decision]'),seen={};
els.forEach(function(el){var d=el.getAttribute('data-mz-decision');if(d&&!seen[d]){seen[d]=1;push('impression',d)}});
if(window.IntersectionObserver){var vd={};var io=new IntersectionObserver(function(es){es.forEach(function(en){
var d=en.target.getAttribute('data-mz-decision');
if(en.isIntersecting&&en.intersectionRatio>=0.5&&d&&!vd[d]){vd[d]=setTimeout(function(){push('viewable',d);},1000)}
else if(d&&vd[d]&&!en.isIntersecting){clearTimeout(vd[d]);delete vd[d]}
})},{threshold:0.5});els.forEach(function(el){io.observe(el)})}
addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden')flush()});
addEventListener('pagehide',flush);setTimeout(flush,4000);
})();`
