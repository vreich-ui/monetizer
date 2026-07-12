import { z } from 'zod'

const envSchema = z.object({
  DATABASE_URL: z.string().default('postgres://monetizer:monetizer@localhost:5432/monetizer'),
  CRED_MASTER_KEY: z.string().default(''),
  ADMIN_TOKEN: z.string().default(''),
  PUBLIC_BASE_URL: z.string().default('http://localhost:8787'),
  // Optional: defaults to PUBLIC_BASE_URL — one Cloud Run URL serves both the
  // API and the click path; a dedicated go.<domain> can be mapped later.
  REDIRECT_BASE_URL: z.string().optional(),
  PORT: z.coerce.number().default(8787),
  LOG_LEVEL: z.string().default('info'),
  POLICY_EPSILON: z.coerce.number().min(0).max(1).default(0.1),
})

export type Config = Omit<z.infer<typeof envSchema>, 'REDIRECT_BASE_URL'> & { REDIRECT_BASE_URL: string }

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.parse(env)
  return { ...parsed, REDIRECT_BASE_URL: parsed.REDIRECT_BASE_URL ?? parsed.PUBLIC_BASE_URL }
}

export const config = loadConfig()
