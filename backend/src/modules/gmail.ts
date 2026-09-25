/**
 * Integração Gmail: OAuth (conta compartilhada), leitura e interpretação dos
 * e-mails do Workflow, gravação de tickets/interações e sincronização
 * incremental (manual pelo app e/ou automática em intervalo).
 */
import { gmail as gmailApi, type gmail_v1 } from "@googleapis/gmail";
import { Router } from "express";
import { OAuth2Client, type Credentials } from "google-auth-library";
import jwt from "jsonwebtoken";
import type { PoolConnection } from "mysql2/promise";
import { authenticate, currentUser, env, exec, HttpError, logger, mapLimit, select, transaction } from "../core";
import { createNotificationForAllUsers, type PushMessage, sendPushToAll } from "./notifications";

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
const NOT_CONNECTED = "Google não conectado.";

/* ============================================================
 * Tokens OAuth (tabela google_tokens: uma única conta compartilhada)
 * ============================================================ */

async function loadTokens(): Promise<Credentials | null> {
  const [row] = await select<{ access_token: string; refresh_token: string | null; expiry_date: Date | null }>(
    "SELECT access_token, refresh_token, expiry_date FROM google_tokens LIMIT 1",
  );
  if (!row) return null;
  return {
    access_token: row.access_token,
    refresh_token: row.refresh_token,
    expiry_date: row.expiry_date ? new Date(row.expiry_date).getTime() : null,
  };
}

async function saveTokens(tokens: Credentials): Promise<void> {
  await transaction(async (conn) => {
    await exec("DELETE FROM google_tokens", [], conn);
    await exec(
      "INSERT INTO google_tokens (access_token, refresh_token, expiry_date) VALUES (?, ?, ?)",
      [tokens.access_token, tokens.refresh_token ?? null, tokens.expiry_date ? new Date(tokens.expiry_date) : null],
      conn,
    );
  });
}

/** Persiste o access_token renovado automaticamente pela biblioteca. */
async function persistRefreshedTokens(tokens: Credentials): Promise<void> {
  if (!tokens.access_token) return;
  const expiry = tokens.expiry_date ? new Date(tokens.expiry_date) : null;
  if (tokens.refresh_token) {
    await exec("UPDATE google_tokens SET access_token = ?, refresh_token = ?, expiry_date = ?", [
      tokens.access_token,
      tokens.refresh_token,
      expiry,
    ]);
  } else {
    await exec("UPDATE google_tokens SET access_token = ?, expiry_date = ?", [tokens.access_token, expiry]);
  }
}

const createOAuthClient = () =>
  new OAuth2Client({
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.GOOGLE_REDIRECT_URI,
  });

async function getGmail(): Promise<gmail_v1.Gmail> {
  const tokens = await loadTokens();
  if (!tokens) throw new HttpError(400, NOT_CONNECTED, "GOOGLE_NOT_CONNECTED");
  const client = createOAuthClient();
  client.setCredentials(tokens);
  client.on("tokens", (t) => {
    persistRefreshedTokens(t).catch((err) => logger.error({ err }, "Falha ao salvar token Google renovado"));
  });
  return gmailApi({ version: "v1", auth: client });
}

/**
 * Converte falhas permanentes de credencial em erros claros (sem stack gigante no log):
 *  - invalid_grant: autorização expirada/revogada -> reconectar pelo app
 *  - deleted_client / invalid_client / unauthorized_client: a credencial OAuth do
 *    Google Cloud (GOOGLE_CLIENT_ID/SECRET) foi excluída ou está errada -> ajustar o servidor
 * Nos dois casos os tokens salvos não servem mais e são descartados.
 */
function normalizeGoogleError(err: unknown): unknown {
  if (err instanceof HttpError) return err;
  const e = err as { response?: { data?: { error?: string } }; message?: string };
  const code = e?.response?.data?.error ?? "";
  const msg = e?.message ?? "";

  if (code === "invalid_grant" || msg.includes("invalid_grant")) {
    void clearTokens();
    return new HttpError(400, `${NOT_CONNECTED} A autorização expirou ou foi revogada. Conecte novamente.`, "GOOGLE_NOT_CONNECTED");
  }
  if (["deleted_client", "invalid_client", "unauthorized_client"].includes(code) || msg.includes("deleted_client")) {
    void clearTokens();
    return new HttpError(
      503,
      "A credencial OAuth do Google foi excluída ou é inválida. O administrador precisa atualizar GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no servidor.",
      "GOOGLE_CLIENT_INVALID",
    );
  }
  return err;
}

async function clearTokens(): Promise<void> {
  await exec("DELETE FROM google_tokens").catch((err) => logger.error({ err }, "Falha ao limpar tokens Google"));
}

/* ============================================================
 * Leitura e interpretação dos e-mails
 * ============================================================ */

interface RawEmail {
  id: string;
  threadId: string | null | undefined;
  internalDate: string | null | undefined;
  subject: string;
  body: string;
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

/** Prioriza a parte text/plain de primeiro nível; senão usa o corpo principal. */
function decodeEmailBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return "";
  const textPart = payload.parts?.find((p) => p.mimeType === "text/plain");
  if (textPart?.body?.data) return decodeBase64Url(textPart.body.data);
  if (payload.body?.data) return decodeBase64Url(payload.body.data);
  return "";
}

const HTML_ENTITIES: Record<string, string> = {
  "&eacute;": "é", "&atilde;": "ã", "&ccedil;": "ç", "&reg;": "®", "&nbsp;": " ",
  "&amp;": "&", "&quot;": '"', "&apos;": "'", "&aacute;": "á", "&agrave;": "à",
  "&acirc;": "â", "&otilde;": "õ", "&iacute;": "í",
};

function cleanEmailBody(body: string): string {
  if (!body) return "";
  return body
    .replace(/\r\n/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/g, (m) => HTML_ENTITIES[m] ?? m)
    .replace(/\n\s*\n/g, "\n\n")
    .trim();
}

export interface ParsedEmail {
  emailMessageId: string;
  subject: string;
  ticketExternoId: string | null;
  empresa: string | null;
  tipoEvento: string;
  descricaoChamado: string | null;
  textoEvento: string | null;
  usuarioNome: string | null;
  usuarioEmail: string | null;
  dataEvento: Date;
}

export function parseEmail(email: RawEmail): ParsedEmail {
  const body = cleanEmailBody(email.body);

  const ticketMatch =
    body.match(/(?:chamado\s*:\s*|chamando de n[úu]mero\s*|n[úu]mero do chamado\s*:\s*|Ticket\s*:\s*)(\d+)/i) ||
    email.subject?.match(/Ticket\s*:\s*(\d+)/i);

  const empresa = body.match(/(?:Empresa|Cliente)\s*:\s*(.+?)(?=\n|$)/i)?.[1]?.trim() ?? null;

  const descricaoChamado =
    body
      .match(
        /Descri[çc][ãa]o do Chamado\s*:\s*([\s\S]*?)(?=\n\s*(?:Texto do Evento|Ultima atividade|Usu[áa]rio|Cordialmente|$))/i,
      )?.[1]
      ?.trim() ?? null;

  let tipoEvento = "desconhecido";
  if (body.includes("Confirmação de abertura de chamado")) tipoEvento = "abertura";
  else if (body.includes("pré-encerramento") || body.includes("pre encerramento")) tipoEvento = "pre_encerramento";
  else if (body.includes("sofreu uma interação")) tipoEvento = "interacao";
  else if (body.includes("Cancelamento") && body.includes("chamando")) tipoEvento = "cancelamento";

  let textoEvento: string | null;
  if (tipoEvento === "cancelamento") {
    textoEvento = body.match(/Motivo do Cancelamento\s*:\s*(.+?)(?=\n|$)/i)?.[1]?.trim() ?? "Cancelamento solicitado";
  } else if (tipoEvento === "pre_encerramento") {
    textoEvento =
      body.match(/Ultima atividade\s*:\s*([\s\S]*?)(?=\n\s*Versão|\n\s*Cordialmente|$)/i)?.[1]?.trim() ?? null;
  } else {
    textoEvento =
      body.match(/Texto do Evento\s*:\s*([\s\S]*?)(?=\n\s*(?:Usu[áa]rio|Cordialmente|$))/i)?.[1]?.trim() ?? null;
  }

  let usuarioNome: string | null = null;
  let usuarioEmail: string | null = null;
  const userPart = body.match(/Usu[áa]rio (?:Intera[çc][ãa]o|Pré-?Encerramento)\s*:\s*(.+?)(?=\n|$)/i)?.[1]?.trim();
  if (userPart) {
    const parts = userPart.match(/(.+?)\s*\((.+?)\)/);
    usuarioNome = parts ? parts[1].trim() : userPart;
    usuarioEmail = parts ? parts[2].trim() : null;
  }

  return {
    emailMessageId: email.id,
    subject: email.subject,
    ticketExternoId: ticketMatch?.[1] ?? null,
    empresa,
    tipoEvento,
    descricaoChamado,
    textoEvento,
    usuarioNome,
    usuarioEmail,
    dataEvento: email.internalDate ? new Date(Number(email.internalDate)) : new Date(),
  };
}

/* ============================================================
 * Persistência
 * ============================================================ */

/** Cria o ticket se não existir e retorna o id (UNIQUE em ticket_externo_id). */
async function ensureTicket(conn: PoolConnection, p: ParsedEmail): Promise<number> {
  const result = await exec(
    `INSERT INTO tickets (ticket_externo_id, empresa, assunto) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
    [p.ticketExternoId, p.empresa, p.subject || null],
    conn,
  );
  return result.insertId;
}

async function insertInteraction(conn: PoolConnection, ticketId: number, p: ParsedEmail): Promise<number> {
  const result = await exec(
    `INSERT INTO interactions
       (ticket_id, email_message_id, assunto_original, tipo_evento, descricao_chamado,
        texto_evento, usuario_nome, usuario_email, data_evento, recebido_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ticketId, p.emailMessageId, p.subject || null, p.tipoEvento, p.descricaoChamado,
      p.textoEvento, p.usuarioNome, p.usuarioEmail, p.dataEvento, p.dataEvento,
    ],
    conn,
  );
  return result.insertId;
}

const ENCERRAMENTO_SUFFIX = "-encerramento";

/**
 * Grava um e-mail (tudo ou nada, via transação) e devolve a mensagem de push
 * correspondente, ou null se o e-mail não tiver número de chamado.
 */
export async function storeEmail(p: ParsedEmail): Promise<PushMessage | null> {
  if (!p.ticketExternoId) return null;

  return transaction(async (conn) => {
    const ticketId = await ensureTicket(conn, p);
    let notified: ParsedEmail = p;

    if (p.tipoEvento === "pre_encerramento") {
      // A "última atividade" vira uma interação comum antes do encerramento
      if (p.textoEvento) await insertInteraction(conn, ticketId, { ...p, tipoEvento: "interacao" });
      notified = {
        ...p,
        textoEvento: "O chamado foi encerrado pelo sistema",
        emailMessageId: `${p.emailMessageId}${ENCERRAMENTO_SUFFIX}`,
      };
    }

    const interactionId = await insertInteraction(conn, ticketId, notified);
    await createNotificationForAllUsers(conn, interactionId);

    return {
      title: `Ticket #${p.ticketExternoId}`,
      body: (notified.textoEvento || "Nova interação no chamado").slice(0, 180),
      data: { ticketId: String(p.ticketExternoId) },
    };
  });
}

/* ============================================================
 * Sincronização incremental
 * ============================================================ */

export interface SyncResult {
  message: string;
  results: { id: string; status: "processed" | "ignored" | "error"; error?: string }[];
}

// E-mails sem número de chamado não são gravados; lembramos deles em memória
// para não baixá-los de novo a cada sincronização.
const ignoredIds = new Set<string>();
const MAX_INDIVIDUAL_PUSHES = 10;
let running: Promise<SyncResult> | null = null;

async function doSync(trigger: string, client?: gmail_v1.Gmail): Promise<SyncResult> {
  const started = Date.now();
  const gmail = client ?? (await getGmail());

  // Percorre as páginas (mais recentes primeiro) até alcançar e-mails já gravados.
  // Assim, mesmo após semanas sem sincronizar, nenhum e-mail fica para trás.
  const messageIds: string[] = [];
  const newIds: string[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    let page: gmail_v1.Schema$ListMessagesResponse;
    try {
      ({ data: page } = await gmail.users.messages.list({
        userId: "me",
        q: env.GMAIL_QUERY,
        maxResults: env.GMAIL_MAX_RESULTS,
        pageToken,
      }));
    } catch (err) {
      throw normalizeGoogleError(err);
    }
    pages++;
    const ids = (page.messages ?? []).map((m) => m.id!).filter(Boolean);
    messageIds.push(...ids);

    // Descarta os já gravados (inclusive os que só geraram "-encerramento")
    const candidates = ids.filter((id) => !ignoredIds.has(id));
    const known = new Set<string>();
    if (candidates.length > 0) {
      const rows = await select<{ email_message_id: string }>(
        "SELECT email_message_id FROM interactions WHERE email_message_id IN (?)",
        [[...candidates, ...candidates.map((id) => id + ENCERRAMENTO_SUFFIX)]],
      );
      for (const r of rows) known.add(r.email_message_id.replace(ENCERRAMENTO_SUFFIX, ""));
    }
    newIds.push(...candidates.filter((id) => !known.has(id)));

    // Para quando a página já contém e-mails gravados (alcançou o histórico)
    const reachedHistory = known.size > 0 || candidates.length < ids.length;
    pageToken = reachedHistory ? undefined : (page.nextPageToken ?? undefined);
  } while (pageToken && messageIds.length < env.GMAIL_SYNC_LIMIT);

  if (pageToken) {
    logger.warn({ limite: env.GMAIL_SYNC_LIMIT }, "Limite de e-mails por sincronização atingido; o restante vem na próxima");
  }

  // Baixa apenas os novos, com concorrência limitada (respeita a cota do Gmail)
  const emails = await mapLimit(newIds, 8, async (id): Promise<RawEmail | { id: string; error: string }> => {
    try {
      const { data } = await gmail.users.messages.get({ userId: "me", id, format: "full" });
      return {
        id,
        threadId: data.threadId,
        internalDate: data.internalDate,
        subject: data.payload?.headers?.find((h) => h.name === "Subject")?.value ?? "",
        body: decodeEmailBody(data.payload),
      };
    } catch (err) {
      return { id, error: (normalizeGoogleError(err) as Error).message };
    }
  });

  // Ordem cronológica: interações entram no banco na ordem em que aconteceram
  emails.sort((a, b) => Number((a as RawEmail).internalDate ?? 0) - Number((b as RawEmail).internalDate ?? 0));

  const results: SyncResult["results"] = [];
  const pushes: PushMessage[] = [];

  for (const email of emails) {
    if ("error" in email) {
      results.push({ id: email.id, status: "error", error: email.error });
      continue;
    }
    try {
      const push = await storeEmail(parseEmail(email));
      if (push) {
        pushes.push(push);
        results.push({ id: email.id, status: "processed" });
      } else {
        ignoredIds.add(email.id);
        results.push({ id: email.id, status: "ignored" });
      }
    } catch (err) {
      logger.error({ err, emailId: email.id }, "Erro ao gravar e-mail");
      results.push({ id: email.id, status: "error", error: "Falha ao gravar o e-mail" });
    }
  }

  // Push fora das transações. Muitos de uma vez (recuperação de atraso) -> um único aviso-resumo.
  if (pushes.length > MAX_INDIVIDUAL_PUSHES) {
    void sendPushToAll([
      {
        title: "Chamados atualizados",
        body: `${pushes.length} novas interações foram sincronizadas.`,
        data: {},
      },
    ]);
  } else {
    void sendPushToAll(pushes);
  }

  const summary = {
    trigger,
    paginas: pages,
    listed: messageIds.length,
    novos: newIds.length,
    processados: pushes.length,
    erros: results.filter((r) => r.status === "error").length,
    ms: Date.now() - started,
  };
  logger.info(summary, "Sincronização concluída");
  return { message: "Sincronização concluída", results };
}

/** Garante uma única sincronização por vez; chamadas simultâneas compartilham o resultado. */
export function syncEmails(trigger: string, client?: gmail_v1.Gmail): Promise<SyncResult> {
  if (!running) {
    running = doSync(trigger, client).finally(() => {
      running = null;
    });
  }
  return running;
}

let timer: NodeJS.Timeout | null = null;

export function startScheduler(): void {
  if (env.SYNC_INTERVAL_MINUTES <= 0) {
    logger.info("Sincronização automática desativada (SYNC_INTERVAL_MINUTES=0)");
    return;
  }
  const interval = env.SYNC_INTERVAL_MINUTES * 60_000;
  const tick = async () => {
    try {
      await syncEmails("agendada");
    } catch (err) {
      if (err instanceof HttpError && err.code?.startsWith("GOOGLE_")) {
        logger.warn({ code: err.code }, `Sincronização agendada ignorada: ${err.message}`);
      } else {
        logger.error({ err }, "Falha na sincronização agendada");
      }
    } finally {
      timer = setTimeout(tick, interval);
      timer.unref();
    }
  };
  timer = setTimeout(tick, 15_000);
  timer.unref();
  logger.info({ minutos: env.SYNC_INTERVAL_MINUTES }, "Sincronização automática ativada");
}

export function stopScheduler(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

/* ============================================================
 * Rotas
 * ============================================================ */

/** Só aceita retorno para o app (scheme próprio) ou para origens web autorizadas. */
function isAllowedRedirect(target: string): boolean {
  try {
    const url = new URL(target);
    if (url.protocol === `${env.APP_SCHEME}:`) return true;
    return (url.protocol === "https:" || url.protocol === "http:") && env.CORS_ORIGINS.includes(url.origin);
  } catch {
    return false;
  }
}

const STATE_AUDIENCE = "google-oauth";

function resultPage(ok: boolean, message: string): string {
  const color = ok ? "#1b873f" : "#c62828";
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Workflow Datapar</title>
<style>body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#f5f5f5}
.c{background:#fff;padding:32px;border-radius:12px;max-width:380px;text-align:center;box-shadow:0 4px 12px rgba(0,0,0,.1)}
h1{color:${color};font-size:20px}</style></head><body><div class="c"><h1>${ok ? "Tudo certo!" : "Não foi possível conectar"}</h1>
<p>${message}</p></div></body></html>`;
}

export const gmailRouter = Router();

gmailRouter.get("/auth/google", authenticate, (req, res) => {
  const redirect = typeof req.query.redirect === "string" ? req.query.redirect : undefined;
  const safeRedirect = redirect && isAllowedRedirect(redirect) ? redirect : null;
  if (redirect && !safeRedirect) req.log.warn({ redirect }, "Redirect do OAuth não autorizado; ignorado");

  // state assinado: protege contra CSRF e open redirect
  const state = jwt.sign({ r: safeRedirect, uid: currentUser(req).id }, env.JWT_SECRET, {
    audience: STATE_AUDIENCE,
    expiresIn: "10m",
  });
  const url = createOAuthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state,
  });
  res.json({ url });
});

gmailRouter.get("/auth/google/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : null;
  const rawState = typeof req.query.state === "string" ? req.query.state : "";

  let state: { r: string | null; uid: number };
  try {
    state = jwt.verify(rawState, env.JWT_SECRET, { audience: STATE_AUDIENCE }) as typeof state;
  } catch {
    res.status(400).type("html").send(resultPage(false, "Link de autorização inválido ou expirado. Tente novamente pelo app."));
    return;
  }

  if (!code) {
    req.log.warn({ error: req.query.error }, "Autorização Google negada");
    res.status(400).type("html").send(resultPage(false, "A autorização foi cancelada. Volte ao app e tente novamente."));
    return;
  }

  try {
    const { tokens } = await createOAuthClient().getToken(code);
    await saveTokens(tokens);
    req.log.info({ userId: state.uid }, "Conta Google conectada");
  } catch (err) {
    req.log.error({ err }, "Falha ao trocar código OAuth por tokens");
    res.status(500).type("html").send(resultPage(false, "Falha na autenticação com o Google. Tente novamente."));
    return;
  }

  if (state.r) {
    const target = new URL(state.r);
    target.searchParams.set("google", "connected");
    res.redirect(target.toString());
    return;
  }
  res.type("html").send(resultPage(true, "Conta Google conectada. Você já pode voltar ao app e sincronizar."));
});

gmailRouter.get("/auth/google/status", authenticate, async (_req, res) => {
  res.json({ connected: (await loadTokens()) !== null });
});

gmailRouter.post("/sync", authenticate, async (req, res) => {
  res.json(await syncEmails(`manual:user=${currentUser(req).id}`));
});
