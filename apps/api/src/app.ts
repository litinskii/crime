import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { Pool } from "pg";
import {
  createMockIncidents,
  filterIncidents,
  paginate,
  calculateStatistics,
  type IncidentsRepository,
} from "@crime-radar/shared";
import { PostgresIncidentsRepository } from "./database/repository";
import { querySchema } from "./schemas";
export async function createApp(
  options: {
    repository?: IncidentsRepository;
    logging?: boolean;
    source?: string;
    databaseUrl?: string;
    origins?: string[];
  } = {},
) {
  const app = Fastify({
    logger: options.logging ?? false,
    bodyLimit: 65536,
    requestTimeout: 10000,
  });
  const origins =
    options.origins ??
    (
      process.env.ALLOWED_ORIGINS ??
      "http://127.0.0.1:5173,http://localhost:5173"
    ).split(",");
  await app.register(cors, {
    origin: origins,
    methods: ["GET"],
    credentials: false,
  });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  const source = options.source ?? process.env.DATA_SOURCE ?? "mock";
  let repository = options.repository;
  let pool: Pool | undefined;
  if (!repository) {
    if (source === "postgres") {
      const url = options.databaseUrl ?? process.env.DATABASE_URL;
      if (!url) throw new Error("DATABASE_URL required for postgres");
      pool = new Pool({
        connectionString: url,
        max: 10,
        statement_timeout: 5000,
      });
      repository = new PostgresIncidentsRepository(
        pool,
        process.env.DATA_SET === "demo" ? "demo" : "real",
      );
      app.addHook("onClose", async () => {
        await pool?.end();
      });
    } else if (source === "mock") {
      const data = createMockIncidents();
      repository = {
        getIncidents: async (q) => paginate(filterIncidents(data, q), q),
        getIncident: async (id) => {
          const incident = data.find((x) => x.id === id);
          if (!incident) throw new Error("Incident not found");
          return incident;
        },
        getStatistics: async (q) => calculateStatistics(data, q),
      };
    } else throw new Error("Unsupported DATA_SOURCE");
  }
  const repo = repository;
  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Cache-Control", "no-store");
  });
  app.get("/health", async () => {
    if (pool) await pool.query("SELECT 1");
    return {
      status: "ok",
      storage: source,
      ingestion: source === "postgres" ? "manual-cli" : "not-configured",
    };
  });
  app.get("/api/v1/incidents", async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success)
      return reply.code(400).send({
        error: "Invalid query",
        issues: parsed.error.issues.map((i) => ({
          path: i.path,
          message: i.message,
        })),
      });
    return repo.getIncidents(parsed.data);
  });
  app.get<{ Params: { id: string } }>(
    "/api/v1/incidents/:id",
    async (request, reply) => {
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(request.params.id))
        return reply.code(400).send({ error: "Invalid incident ID" });
      try {
        return await repo.getIncident(request.params.id);
      } catch (error) {
        if (error instanceof Error && error.message === "Incident not found")
          return reply.code(404).send({ error: "Incident not found" });
        throw error;
      }
    },
  );
  app.get("/api/v1/statistics", async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success)
      return reply.code(400).send({ error: "Invalid query" });
    return repo.getStatistics(parsed.data);
  });
  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "Request failed");
    reply.code(500).send({ error: "Internal server error" });
  });
  return app;
}
