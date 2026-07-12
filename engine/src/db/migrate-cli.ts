import { createDb } from './client.ts'
import { migrate } from './migrate.ts'
import { config } from '../config.ts'

const db = createDb(config.DATABASE_URL)
const applied = await migrate(db)
console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date')
await db.close()
