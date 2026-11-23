import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import type { Pool } from "pg";
import { registerHealthRoutes } from "./routes.ts";
import type { WhatsAppConnector, ConnectionStatus } from "../whatsapp/connector.ts";

function fakePool(shouldFail = false): Pool {
  return {
    query: async () => {
      if (shouldFail) throw new Error("connection refused");
      return { rows: [{ "?column?": 1 }] };
    },
  } as unknown as Pool;
}

function fakeConnector(status: ConnectionStatus): WhatsAppConnector {
  return {
    connect: async () => {},
    disconnect: async () => {},
    sendText: async () => ({ messageId: "x", sentAt: new Date() }),
    sendMention: async () => ({ messageId: "x", sentAt: new Date() }),
  sendDocument: async () => ({ messageId: "x", sentAt: new Date() }),
    getConnectionStatus: () => status,
    onMessage: () => {},
    onMessageUpdate: () => {},
    onConnectionUpdate: () => {},
  };
}

test("/healthz always reports ok without touching the database", async () => {
  const app = Fastify();
  registerHealthRoutes(app, fakePool());
  const res = await app.inject({ method: "GET", url: "/healthz" });
  assert.equal(res.statusCode, 200);
});

test("/readyz reports unavailable when the database is unreachable", async () => {
  const app = Fastify();
  registerHealthRoutes(app, fakePool(true));
  const res = await app.inject({ method: "GET", url: "/readyz" });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().reason, "database");
});

// Chief-review finding: a dead WhatsApp socket must fail readiness.
test("/readyz reports unavailable when the WhatsApp connector is disconnected", async () => {
  const app = Fastify();
  registerHealthRoutes(app, fakePool(), fakeConnector({ connected: false }));
  const res = await app.inject({ method: "GET", url: "/readyz" });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().reason, "whatsapp_disconnected");
});

test("/readyz reports ok when the database and connector are both healthy", async () => {
  const app = Fastify();
  registerHealthRoutes(app, fakePool(), fakeConnector({ connected: true }));
  const res = await app.inject({ method: "GET", url: "/readyz" });
  assert.equal(res.statusCode, 200);
});

// A quiet group is not a readiness failure — message staleness is an
// alerting concern (Phase 3 job), not a healthcheck/restart trigger.
test("/readyz stays ok even if no message has arrived recently, as long as the socket is connected", async () => {
  const app = Fastify();
  const staleLastMessage = new Date(Date.now() - 1000 * 60 * 60 * 24 * 3); // 3 days ago
  registerHealthRoutes(app, fakePool(), fakeConnector({ connected: true, lastMessageAt: staleLastMessage }));
  const res = await app.inject({ method: "GET", url: "/readyz" });
  assert.equal(res.statusCode, 200);
});

test("/readyz has no connector requirement when none is passed (Phase 1)", async () => {
  const app = Fastify();
  registerHealthRoutes(app, fakePool());
  const res = await app.inject({ method: "GET", url: "/readyz" });
  assert.equal(res.statusCode, 200);
});
