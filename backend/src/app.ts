/**
 * Montagem do Express: segurança, logs de requisição, rotas e tratamento de erros.
 */
import compression from "compression";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import { pinoHttp } from "pino-http";
import { env, HttpError, isProd, logger, pool } from "./core";
import { gmailRouter } from "./modules/gmail";
import { notificationsRouter } from "./modules/notifications";
import { ticketsRouter } from "./modules/tickets";
import { usersRouter } from "./modules/users";

function parseTrustProxy(value: string): boolean | number | string {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", parseTrustProxy(env.TRUST_PROXY));

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = (req.headers["x-request-id"] as string) || randomUUID();
        res.setHeader("X-Request-Id", id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === "/health" },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info"),
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url, ip: req.remoteAddress }),
        res: (res) => ({ status: res.statusCode }),
      },
    }),
  );

  app.use(helmet());
  app.use(
    cors({
      // Apps nativos não enviam Origin; navegadores só são aceitos se listados
      origin: (origin, cb) => cb(null, !origin || env.CORS_ORIGINS.includes(origin)),
      methods: ["GET", "POST", "PUT", "DELETE"],
      allowedHeaders: ["Content-Type", "Authorization"],
      maxAge: 600,
    }),
  );
  app.use(compression());
  app.use(express.json({ limit: "100kb" }));

  app.get("/health", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "ok", db: "connected", uptime: Math.round(process.uptime()) });
    } catch {
      res.status(503).json({ status: "error", db: "disconnected" });
    }
  });

  app.use("/users", usersRouter);
  app.use("/tickets", ticketsRouter);
  app.use("/notifications", notificationsRouter);
  app.use(gmailRouter); // /auth/google*, /sync

  app.use((_req, _res, next) => next(new HttpError(404, "Rota não encontrada", "NOT_FOUND")));

  // Express 5 encaminha erros de handlers async para cá automaticamente
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    const e = err as { type?: string; status?: number };
    if (e?.type === "entity.parse.failed") {
      res.status(400).json({ error: "JSON inválido", code: "BAD_JSON" });
      return;
    }
    if (e?.type === "entity.too.large") {
      res.status(413).json({ error: "Requisição muito grande", code: "TOO_LARGE" });
      return;
    }
    req.log.error({ err }, "Erro não tratado");
    res.status(500).json({
      error: isProd ? "Erro interno do servidor" : (err as Error)?.message ?? "Erro interno",
      code: "INTERNAL",
      requestId: req.id,
    });
  });

  return app;
}
