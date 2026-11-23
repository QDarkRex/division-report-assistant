import { readFileSync } from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import PgBoss from "pg-boss";
import * as schema from "../db/schema.ts";
import type { AppDatabase } from "../db/types.ts";
import { loadConfig, type AppConfig } from "../config/env.ts";
import { registerHealthRoutes } from "../health/routes.ts";
import { BaileysConnector } from "../whatsapp/baileys-connector.ts";
import { processIncomingMessage } from "../messages/pipeline.ts";
import { formatAcknowledgment } from "../messages/acknowledgment.ts";
import { registerScheduledJobs, type SheetsSyncConfig } from "../jobs/scheduler.ts";
import { createReadOnlySheetsClient } from "../plan/sheet-source.ts";
import type { PlanSyncConfig } from "../plan/run.ts";
import { createSheetsClient } from "../sheets/client.ts";
import type { IncomingMessage, WhatsAppConnector } from "../whatsapp/connector.ts";

export interface AppBundle {
  app: FastifyInstance;
  config: AppConfig;
  db: AppDatabase;
  connector: WhatsAppConnector;
  pool: Pool;
}

async function handleIncomingMessage(
  app: FastifyInstance,
  db: AppDatabase,
  config: AppConfig,
  connector: WhatsAppConnector,
  message: IncomingMessage,
): Promise<void> {
  try {
    const outcome = await processIncomingMessage(
      {
        db,
        llm: {
          baseUrl: config.LITELLM_BASE_URL,
          ...(config.LITELLM_API_KEY ? { apiKey: config.LITELLM_API_KEY } : {}),
        },
        model: config.WDH_LLM_MODEL,
      },
      message,
    );
    if (outcome.status === "query_answered" && outcome.intentSource) {
      app.log.info({ messageId: message.messageId, intentSource: outcome.intentSource }, "query intent decided");
    }
    const ackText = formatAcknowledgment(outcome);
    // The document goes first, with the reply as its caption: a file that
    // arrives after its explanation reads as a second, unexplained message.
    if (outcome.status === "query_answered" && outcome.attachment) {
      await connector.sendDocument({
        chatJid: message.chatJid,
        content: outcome.attachment.content,
        fileName: outcome.attachment.fileName,
        mimeType: outcome.attachment.mimeType,
        ...(ackText ? { caption: ackText } : {}),
      });
      return;
    }
    if (ackText) {
      await connector.sendText({ chatJid: message.chatJid, text: ackText, quotedMessageId: message.messageId });
    }
  } catch (error) {
    app.log.error({ err: error, messageId: message.messageId }, "failed to process incoming message");
  }
}

/**
 * Pure construction: builds the Fastify app, DB handle, and WhatsApp
 * connector, and wires the connector's onMessage handler to the pipeline.
 * Does NOT connect anything live — that's main()'s job — so this stays
 * usable in tests without touching a real socket or database pool.
 */
export function buildApp(config = loadConfig()): AppBundle {
  const app = Fastify({ logger: true });
  const pool = new Pool({ connectionString: config.DATABASE_URL });
  const db = drizzle(pool, { schema });
  const connector = new BaileysConnector({ authStateFolder: config.WHATSAPP_AUTH_FOLDER, allowedGroupJid: config.WHATSAPP_GROUP_JID });

  registerHealthRoutes(app, pool, connector);

  connector.onMessage((message) => void handleIncomingMessage(app, db, config, connector, message));

  app.addHook("onClose", async () => {
    await connector.disconnect();
    await pool.end();
  });

  return { app, config, db, connector, pool };
}

async function main() {
  const config = loadConfig();
  const { app, db, connector } = buildApp(config);

  let boss: PgBoss | undefined;

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    if (boss) await boss.stop({ graceful: true, timeout: 5000 });
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ host: "0.0.0.0", port: config.PORT });

  // Connector/scheduler start after the HTTP listener so /healthz answers
  // immediately even while WhatsApp is still reconnecting — /readyz is the
  // gate that actually checks connector.getConnectionStatus().
  await connector.connect();

  let sheetsSync: SheetsSyncConfig | undefined;
  if (config.SHEETS_CREDENTIALS_PATH && config.SHEETS_SPREADSHEET_ID) {
    const serviceAccountKeyJson = readFileSync(config.SHEETS_CREDENTIALS_PATH, "utf-8");
    sheetsSync = {
      sheets: createSheetsClient({ serviceAccountKeyJson, spreadsheetId: config.SHEETS_SPREADSHEET_ID }),
      spreadsheetId: config.SHEETS_SPREADSHEET_ID,
      ...(config.SHEETS_ADMIN_ACTOR_MEMBER_ID ? { adminActorMemberId: config.SHEETS_ADMIN_ACTOR_MEMBER_ID } : {}),
    };
  }

  // The external plan spreadsheet: read-only client, job registered only when
  // its id is configured (src/plan/).
  let planSync: PlanSyncConfig | undefined;
  if (config.PLAN_SPREADSHEET_ID && config.SHEETS_CREDENTIALS_PATH) {
    planSync = {
      sheets: createReadOnlySheetsClient(readFileSync(config.SHEETS_CREDENTIALS_PATH, "utf-8")),
      spreadsheetId: config.PLAN_SPREADSHEET_ID,
      sheetName: config.PLAN_SHEET_NAME,
      sourceKey: config.PLAN_SOURCE_KEY,
      projectName: config.PLAN_PROJECT_NAME,
    };
  }

  boss = new PgBoss({ connectionString: config.DATABASE_URL });
  boss.on("error", (error) => app.log.error({ err: error }, "pg-boss error"));
  await boss.start();
  await registerScheduledJobs({
    db,
    boss,
    sendGroupText: async (text) => {
      await connector.sendText({ chatJid: config.WHATSAPP_GROUP_JID, text });
    },
    sendGroupMention: async (text, mentionedJids) => {
      await connector.sendMention({ chatJid: config.WHATSAPP_GROUP_JID, text, mentionedJids });
    },
    ...(sheetsSync ? { sheetsSync } : {}),
    ...(planSync ? { planSync } : {}),
    morningBrief: {
      llm: { baseUrl: config.LITELLM_BASE_URL, ...(config.LITELLM_API_KEY ? { apiKey: config.LITELLM_API_KEY } : {}) },
      model: config.WDH_LLM_MODEL,
    },
  });

  app.log.info("WDH fully wired: WhatsApp connector connecting, scheduler running");
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href;
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
