import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "./schema.ts";

/** Driver-agnostic database handle so services work against both the
 * production node-postgres pool and the in-memory pglite test database. */
export type AppDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;
