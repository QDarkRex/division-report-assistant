import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { WhatsAppConnector } from "../whatsapp/connector.ts";

/**
 * Liveness/readiness endpoints per MASTER_SPEC.md §18.
 *
 * `connector` is optional because Phase 1 has no Baileys implementation
 * yet — Phase 2 passes the real connector here. /readyz gates only on
 * `connected` (chief-review finding: a dead socket must fail readiness so
 * the container gets recycled). It deliberately does NOT gate on message
 * staleness — see the comment on ConnectionStatus.lastMessageAt.
 */
export function registerHealthRoutes(app: FastifyInstance, pool: Pool, connector?: WhatsAppConnector): void {
  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async (_request, reply) => {
    try {
      await pool.query("SELECT 1");
    } catch (error) {
      app.log.error({ err: error }, "readiness check failed: database");
      return reply.code(503).send({ status: "unavailable", reason: "database" });
    }

    if (connector) {
      const status = connector.getConnectionStatus();
      if (!status.connected) {
        return reply.code(503).send({ status: "unavailable", reason: "whatsapp_disconnected" });
      }
    }

    return { status: "ok" };
  });
}
