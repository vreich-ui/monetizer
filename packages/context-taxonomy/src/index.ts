import { z } from 'zod'

/**
 * Context taxonomy v1 — the contract between content generation and the
 * monetization engine (docs/plan/00 §Correction 3, 01 §Surface).
 *
 * Content agents author surface declarations against this package.
 * Version bumps are deliberate events: the engine records which taxonomy
 * version each surface was authored against.
 */
export const TAXONOMY_VERSION = '1.0.0'

export const INTENT_CLASSES = [
  // "best X for Y", comparisons, reviews — highest monetization value
  'commercial_investigation',
  // "buy X", "X discount", direct purchase intent
  'transactional',
  // how-tos, explainers — monetizable via contextual offers, lower CVR
  'informational',
  // quizzes, tools, calculators — engagement assets; tip-jar / indirect
  'engagement',
] as const
export type IntentClass = (typeof INTENT_CLASSES)[number]

export const SLOT_TYPES = [
  'inline_link', // a link inside prose
  'product_box', // a single-offer card
  'comparison_table', // multi-offer table (k offers)
  'end_cta', // end-of-article call to action
  'quiz_result', // offer shown on a quiz/tool result screen
  'download_offer', // digital product (PDF/guide/template) placement
  'tip_jar', // donation surface
] as const
export type SlotType = (typeof SLOT_TYPES)[number]

export const surfaceContextSchema = z.object({
  intent_class: z.enum(INTENT_CLASSES),
  topic: z.string().min(1).max(200),
  entities: z.array(z.string().min(1).max(120)).max(50).default([]),
  keywords: z.array(z.string().min(1).max(80)).max(50).default([]),
  locale: z.string().min(2).max(12).default('en-US'),
  audience_geo: z.array(z.string().length(2)).max(30).optional(),
})
export type SurfaceContext = z.infer<typeof surfaceContextSchema>

export const surfaceDeclarationSchema = z.object({
  content_id: z.string().min(1).max(300),
  url_path: z.string().min(1).max(500),
  slot_key: z.string().min(1).max(120),
  slot_type: z.enum(SLOT_TYPES),
  context: surfaceContextSchema,
  context_version: z.string().default(TAXONOMY_VERSION),
})
export type SurfaceDeclaration = z.infer<typeof surfaceDeclarationSchema>
