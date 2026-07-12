import { z } from 'zod'

const envSchema = z.object({
  DATABASE_URL: z.string().default('postgres://monetizer:monetizer@localhost:5432/monetizer'),
  CRED_MASTER_KEY: z.string().default(''),
  ADMIN_TOKEN: z.string().default(''),
  PUBLIC_BASE_URL: z.string().default('http://localhost:8787'),
  REDIRECT_BASE_URL: z.string().default('http://localhost:8787'),
  PORT: z.coerce.number().default(8787),
  LOG_LEVEL: z.string().default('info'),
  POLICY_EPSILON: z.coerce.number().min(0).max(1).default(0.1),
})

export type Config = z.infer<typeof envSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return envSchema.parse(env)
}

export const config = loadConfig()
