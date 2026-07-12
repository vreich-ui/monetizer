import type { SurfaceContext, SlotType } from '@monetizer/context-taxonomy'

export type Fidelity = 'click' | 'surface' | 'property' | 'account'
export type SubidFidelity = 'click' | 'surface' | 'property' | 'none'
export type OfferKind = 'affiliate_product' | 'affiliate_program_cta' | 'digital_product' | 'donation'
export type Lifecycle = 'active' | 'stale' | 'dead' | 'paused'

export interface Merchant {
  name: string
  slug: string
  domain?: string
  program_id?: string
}

export interface Economics {
  type: 'commission_pct' | 'commission_fixed' | 'sale_margin' | 'donation'
  rate?: number // 0..1 for commission_pct
  amount?: number // fixed commission / margin / suggested donation
  currency: string
  cookie_window_days?: number
  aov_estimate?: number
}

export interface Price {
  amount: number
  currency: string
  as_of: string // ISO timestamp
}

export interface OfferConstraints {
  geo?: string[]
  tos?: {
    max_price_age_h?: number
    disclosure_text?: string
    redirect_transparency_required?: boolean
    [k: string]: unknown
  }
}

export interface OfferTracking {
  /**
   * URL template the redirect fills at click time. Placeholders:
   *   {click_id}    first-party click ULID (subid injection)
   *   {tenant_ns}   tenant's tracking namespace for this network
   *   {url_enc}     url-encoded destination (deeplink templates)
   */
  link_template: string
  subid_fidelity: SubidFidelity
  destination_url?: string
}

export interface Offer {
  id: string
  source_id: string
  network_offer_id: string
  program_id?: string | null
  kind: OfferKind
  merchant: Merchant
  title: string
  brand?: string | null
  description?: string | null
  image_url?: string | null
  taxonomy: { category_path?: string[]; entities?: string[]; keywords?: string[] }
  economics: Economics
  price?: Price | null
  constraints: OfferConstraints
  tracking: OfferTracking
  lifecycle: Lifecycle
}

export interface Surface {
  id: string
  tenant_id: string
  content_id: string
  slot_key: string
  url_path: string
  slot_type: SlotType
  context: SurfaceContext
  context_version: string
  status: 'active' | 'retired'
}

export interface ScoreComponents {
  relevance: number
  econ_value: number
  freshness: number
  [k: string]: number
}

export interface Candidate {
  offer_id: string
  score: number
  components: ScoreComponents
}

export interface Chosen {
  offer_id: string
  rank: number
  presentation?: Record<string, unknown>
}

export interface Decision {
  id: string
  surface_id: string
  tenant_id: string
  build_id?: string | null
  policy: { name: string; version: string; params_hash: string }
  candidates: Candidate[]
  chosen: Chosen[]
  propensity: number
  explore: boolean
  seed?: string | null
  status: 'live' | 'superseded'
  issued_at: string
}

export interface Tenant {
  id: string
  slug: string
  name: string
  domains: string[]
  netlify_build_hook_url?: string | null
  tracking_namespaces: Record<string, string>
  status: 'active' | 'paused'
}

export type NormalizedStatus = 'pending' | 'approved' | 'reversed' | 'adjusted' | 'paid'

export interface ConversionObservationInput {
  source_id: string
  network_txn_id: string
  network_click_time?: string | null
  network_txn_time: string
  subid_echo?: string | null
  tracking_key?: string | null
  program_ref?: string | null
  items?: unknown
  order_amount?: number | null
  commission_amount: number
  currency: string
  network_status: string
  status_norm: NormalizedStatus
  raw?: unknown
}
