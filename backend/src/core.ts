/**
 * Núcleo da API: configuração validada, logger, pool MySQL, autenticação
 * JWT, erros HTTP e utilitários compartilhados pelos módulos.
 */
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import mysql from "mysql2/promise";
import pino from "pino";
import { z } from "zod";

/* ============================================================
 * Configuração (falha cedo e com mensagem clara)
 * ============================================================ */

const csv = (v: string) =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(8080),
  TRUST_PROXY: z.string().default("loopback"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  APP_TIMEZONE: z.string().default("America/Sao_Paulo"),

  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_USER: z.string().min(1),
  DB_PASS: z.string().default(""),
  DB_NAME: z.string().min(1),
  DB_POOL_SIZE: z.coerce.number().int().positive().default(10),

  JWT_SECRET: z
    .string()
    .min(32, "JWT_SECRET precisa ter pelo menos 32 caracteres (gere com: openssl rand -base64 48)"),
  JWT_EXPIRES_IN: z.string().default("1d"),
  CORS_ORIGINS: z.string().default("").transform(csv),
  APP_SCHEME: z.string().default("fluxoemailschamados"),

  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REDIRECT_URI: z.url(),
  GMAIL_QUERY: z.string().default("from:workflow@datapardelivery.com.br"),
  GMAIL_MAX_RESULTS: z.coerce.number().int().min(1).max(500).default(250), // tamanho da página
  GMAIL_SYNC_LIMIT: z.coerce.number().int().min(1).max(20000).default(3000), // teto por sincronização
  SYNC_INTERVAL_MINUTES: z.coerce.number().min(0).default(0),

  INTERNAL_EMAIL_DOMAINS: z
    .string()
    .default("apk.com.br,apklog.com.br")
    .transform((v) => csv(v).map((d) => d.toLowerCase().replace(/^@/, ""))),
  TICKETS_MONTHS: z.coerce.number().int().min(1).max(120).default(6),
});

function loadEnv() {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // console.error vai direto para o journald/stdout mesmo sem logger pronto
    console.error("\n[FATAL] Configuração inválida. Verifique o arquivo de ambiente:\n");
    for (const issue of parsed.error.issues) {
      const msg = issue.message.includes("received undefined") ? "variável obrigatória não definida" : issue.message;
      console.error(`  - ${issue.path.join(".") || "(raiz)"}: ${msg}`);
    }
    console.error("");
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
export const isProd = env.NODE_ENV === "production";

// Garante que Node e mysql2 interpretem DATETIME no mesmo fuso do app,
// independentemente do fuso configurado no servidor Debian.
process.env.TZ = env.APP_TIMEZONE;

/* ============================================================
 * Logger (JSON em produção -> journald; legível em dev)
 * ============================================================ */

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { app: "fluxo-api" },
  redact: {
    paths: ["req.headers.authorization", "req.headers.cookie", "*.senha", "*.password", "*.token"],
    censor: "[oculto]",
  },
  ...(isProd
    ? {}
    : { transport: { target: "pino-pretty", options: { translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname,app" } } }),
});

/* ============================================================
 * Banco de dados
 * ============================================================ */

export const pool = mysql.createPool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASS,
  database: env.DB_NAME,
  connectionLimit: env.DB_POOL_SIZE,
  waitForConnections: true,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10_000,
  charset: "utf8mb4",
  timezone: "local",
  connectTimeout: 10_000,
});

export type Db = Pick<mysql.Pool | mysql.PoolConnection, "query">;
export type Row = mysql.RowDataPacket;

/** SELECT tipado. Arrays em parâmetros são expandidos (ex.: `IN (?)`). */
export async function select<T>(sql: string, params: unknown[] = [], db: Db = pool): Promise<T[]> {
  const [rows] = await db.query<Row[]>(sql, params);
  return rows as unknown as T[];
}

/** INSERT/UPDATE/DELETE. */
export async function exec(sql: string, params: unknown[] = [], db: Db = pool): Promise<mysql.ResultSetHeader> {
  const [result] = await db.query<mysql.ResultSetHeader>(sql, params);
  return result;
}

/** Executa `fn` numa transação; faz rollback automático em caso de erro. */
export async function transaction<T>(fn: (conn: mysql.PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback().catch(() => undefined);
    throw err;
  } finally {
    conn.release();
  }
}

/** Aguarda o banco ficar disponível (útil no boot junto com o MariaDB/MySQL). */
export async function waitForDatabase(attempts = 10): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query("SELECT 1");
      logger.info({ host: env.DB_HOST, db: env.DB_NAME }, "Banco de dados conectado");
      return;
    } catch (err) {
      const e = err as { code?: string; message?: string };
      logger.error({ attempt: i, code: e.code, detail: e.message }, "Falha ao conectar no banco");
      if (i === attempts) throw err;
      await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** (i - 1), 15_000)));
    }
  }
}

/* ============================================================
 * Erros HTTP e validação
 * ============================================================ */

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new HttpError(400, first?.message ?? "Dados inválidos", "VALIDATION");
  }
  return result.data;
}

/* ============================================================
 * Autenticação
 * ============================================================ */

export interface AuthUser {
  id: number;
  email: string;
  nome: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function signToken(user: AuthUser): string {
  return jwt.sign({ id: user.id, email: user.email, nome: user.nome }, env.JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"],
  });
}

export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) {
    return next(new HttpError(401, "Token não fornecido", "UNAUTHENTICATED"));
  }
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ["HS256"] }) as AuthUser;
    req.user = { id: Number(decoded.id), email: decoded.email, nome: decoded.nome };
    return next();
  } catch {
    return next(new HttpError(401, "Token inválido ou expirado", "UNAUTHENTICATED"));
  }
}

/** Usuário autenticado (use somente após `authenticate`). */
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw new HttpError(401, "Usuário não autenticado", "UNAUTHENTICATED");
  return req.user;
}

/* ============================================================
 * Utilitários
 * ============================================================ */

const dateFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: env.APP_TIMEZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Formata como "dd/mm/aaaa hh:mm:ss" (formato já consumido pelo app). */
export function formatDateTime(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value as string);
  if (Number.isNaN(d.getTime())) return null;
  return dateFormatter.format(d).replace(",", "");
}

/** Executa `fn` sobre `items` com no máximo `limit` promessas simultâneas. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}
