import { z } from "zod";

/**
 * compose.yaml passes optional settings as `NAME: ${WDH_NAME:-}`, which hands
 * the container an EMPTY string when the host does not set them. For an
 * optional setting an empty string means "not set", not "invalid".
 */
const blankAsUnset = (value: unknown): unknown => (typeof value === "string" && value.trim() === "" ? undefined : value);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  PORT: z.coerce.number().int().positive().default(8000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  // Verified live on the server (2026-08-07): LiteLLM's gateway container is
  // already on the shared `app-data` Docker network (DNS alias
  // `gateway`), which this service also joins — see compose.yaml.
  LITELLM_BASE_URL: z.string().url().default("http://gateway:4000"),
  // Should be a LiteLLM *virtual key* scoped to the Rp15k/Rp25k monthly
  // budget, not the raw LITELLM_MASTER_KEY — see the "enforce budget cap
  // as a LiteLLM virtual-key limit" commitment in ADR-0010's addendum.
  // Creating that virtual key is a deploy-time operational step, not code.
  LITELLM_API_KEY: z.string().min(1).optional(),
  // The LiteLLM alias WDH asks for. Default is the flash tier the bot has
  // always used. Made configurable 2026-09-11 so swapping the model — if a
  // better price/performance one appears — is a config change plus a
  // restart, not a code deploy. It must be an alias LiteLLM actually
  // serves; a value the gateway does not know fails every extraction. As
  // of 2026-09-11 DeepSeek's catalogue lists deepseek-flash and
  // deepseek-v4-pro — there is no "v4.1 flash".
  WDH_LLM_MODEL: z.string().min(1).default("deepseek-v4-flash"),
  // Matches pair.ts's default and compose.yaml's `wdh-data` volume mount —
  // the already-paired session lives here, do not point this elsewhere.
  WHATSAPP_AUTH_FOLDER: z.string().min(1).default("/opt/app/data/division-report-assistant/baileys-session"),
  // The Electrical Division group this bot reads from and replies into.
  // No safe default — sending to the wrong group is a real-world mistake,
  // not a config nicety, so this must be set explicitly at deploy time.
  WHATSAPP_GROUP_JID: z.string().min(1, "WHATSAPP_GROUP_JID is required").regex(/@g\.us$/, "must be a group JID ending in @g.us"),
  // Two-way Sheets sync (MASTER_SPEC.md §18) — optional, same pattern as
  // LITELLM_API_KEY: absent on a dev box or before the service account
  // key exists, registerScheduledJobs() just skips the sync job rather
  // than requiring this everywhere to boot.
  SHEETS_CREDENTIALS_PATH: z.string().min(1).optional(),
  SHEETS_SPREADSHEET_ID: z.string().min(1).optional(),
  // Attributed as taskEvents.actorMemberId for admin_sheet_edit events.
  // Optional — Sheets doesn't reliably expose per-cell edit authorship,
  // so this is "the configured admin," not a real per-editor identity.
  SHEETS_ADMIN_ACTOR_MEMBER_ID: z.string().uuid().optional(),
  // External plan spreadsheet that is the source of truth for plan tasks
  // (src/plan/). Optional: the sync job is registered only when
  // PLAN_SPREADSHEET_ID is set (the key comes from SHEETS_CREDENTIALS_PATH).
  // The bot only ever READS this spreadsheet — the client is built with the
  // spreadsheets.readonly scope, so Google itself refuses a write.
  PLAN_SPREADSHEET_ID: z.preprocess(blankAsUnset, z.string().min(1).optional()),
  PLAN_SHEET_NAME: z.preprocess(blankAsUnset, z.string().min(1).default("Master Plan")),
  // Becomes the source_reference prefix `master-plan-<key>:` and the
  // plan_ref prefix `<key>:`. Changing it orphans the existing plan_items.
  PLAN_SOURCE_KEY: z.preprocess(
    blankAsUnset,
    z
      .string()
      .min(1)
      .regex(/^[a-z0-9-]+$/, "lowercase letters, digits and dashes only")
      .default("aerolift"),
  ),
  PLAN_PROJECT_NAME: z.preprocess(blankAsUnset, z.string().min(1).default("Aerolift Drone Mobil")),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  return envSchema.parse(source);
}
