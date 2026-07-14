import { z } from 'zod'

/**
 * Bounded-but-liberal connection config. Agents declare HOW to authenticate and
 * WHAT to collect; the engine executes it deterministically. Secrets are stored
 * separately (encrypted); this config references them by key in templates.
 */

// {field} placeholders resolve from the connection's secrets (and run vars).
const templateString = z.string().max(2000)

export const authSchema = z.object({
  type: z.enum([
    'none',
    'bearer', // Authorization: Bearer <token>
    'api_key_header', // <header_name>: <value>
    'basic', // Authorization: Basic base64(user:pass)
    'query_param', // ?<param>=<value>
    'oauth2_client_credentials', // fetch token from token_url, then Bearer
  ]),
  // api_key_header
  header_name: z.string().max(100).optional(),
  // query_param
  query_param: z.string().max(100).optional(),
  // Value template using {secretKey} placeholders. Defaults sensibly per type.
  value_template: templateString.optional(),
  // basic
  username_key: z.string().max(100).optional(),
  password_key: z.string().max(100).optional(),
  // oauth2_client_credentials
  token_url: z.string().url().optional(),
  client_id_key: z.string().max(100).optional(),
  client_secret_key: z.string().max(100).optional(),
  scope: z.string().max(500).optional(),
})
export type AuthConfig = z.infer<typeof authSchema>

export const recipeSchema = z.object({
  name: z.string().min(1).max(80),
  sink: z.enum(['transactions', 'offers', 'none']).default('none'),
  method: z.enum(['GET', 'POST']).default('GET'),
  // path is appended to base_url; supports {since_iso},{since_date},{page},{offset},{cursor}
  path: z.string().max(1000),
  query: z.record(z.string()).optional(),
  headers: z.record(z.string()).optional(),
  body: z.unknown().optional(),
  // dot-path to the array of records in the JSON response ('' = response is the array)
  records_path: z.string().max(200).default(''),
  paginate: z
    .object({
      type: z.enum(['page', 'offset', 'cursor', 'link']),
      param: z.string().max(80).optional(), // page/offset/cursor query param name
      size: z.number().int().min(1).max(1000).default(100),
      size_param: z.string().max(80).optional(),
      next_path: z.string().max(200).optional(), // for cursor/link: dot-path to next token/url
      max_pages: z.number().int().min(1).max(200).default(50),
    })
    .optional(),
  // our_field -> 'dot.path' into a record, or '=literal' for a constant
  map: z.record(z.string()).default({}),
  defaults: z.record(z.unknown()).default({}),
  since_days: z.number().int().min(0).max(400).default(45),
  schedule_s: z.number().int().min(300).max(30 * 86400).optional(),
})
export type Recipe = z.infer<typeof recipeSchema>

export const connectionConfigSchema = z.object({
  base_url: z.string().url().optional(),
  auth: authSchema.default({ type: 'none' }),
  headers: z.record(z.string()).default({}),
  verify: z
    .object({
      method: z.enum(['GET', 'POST']).default('GET'),
      path: z.string().max(1000).default(''),
      expect_status_below: z.number().int().min(200).max(600).default(400),
    })
    .optional(),
  recipes: z.array(recipeSchema).max(25).default([]),
  // Free-text note for agents (never executed) — e.g. supplier quirks, docs URL.
  instructions: z.string().max(8000).optional(),
})
export type ConnectionConfig = z.infer<typeof connectionConfigSchema>

// Secrets: arbitrary string map, bounded so a connection can't smuggle blobs.
export const secretsSchema = z
  .record(z.string().max(8192))
  .refine((o) => Object.keys(o).length <= 50, 'at most 50 secret fields')
