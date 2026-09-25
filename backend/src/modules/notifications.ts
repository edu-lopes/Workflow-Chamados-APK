/**
 * Notificações: não lidas do usuário, marcação como lida, leitores de
 * interações e envio de push (Expo) em lote. Rotas montadas em /notifications.
 */
import { Router } from "express";
import { z } from "zod";
import { authenticate, currentUser, type Db, exec, logger, parse, select } from "../core";

const IdParam = z.object({ id: z.coerce.number().int().positive("ID inválido") });
const TicketParam = z.object({ ticketId: z.string().trim().min(1).max(50) });

/** Cria a notificação da interação e um registro "não lido" para cada usuário. */
export async function createNotificationForAllUsers(db: Db, interactionId: number): Promise<void> {
  const result = await exec("INSERT INTO notifications (interaction_id) VALUES (?)", [interactionId], db);
  await exec(
    "INSERT INTO user_notifications (user_id, notification_id) SELECT id, ? FROM users",
    [result.insertId],
    db,
  );
}

export interface ReaderRow {
  interaction_id: number;
  id: number;
  nome: string;
  email: string;
  icon_color: string;
}

/** Leitores (lido = true) de várias interações numa única consulta. */
export async function readersByInteraction(interactionIds: number[]): Promise<Map<number, ReaderRow[]>> {
  const map = new Map<number, ReaderRow[]>();
  if (interactionIds.length === 0) return map;

  const rows = await select<ReaderRow>(
    `SELECT n.interaction_id, u.id, u.nome, u.email,
            COALESCE(us.icon_color, '#255088') AS icon_color
       FROM notifications n
       JOIN user_notifications un ON un.notification_id = n.id AND un.lido = TRUE
       JOIN users u ON u.id = un.user_id
       LEFT JOIN user_settings us ON us.user_id = u.id
      WHERE n.interaction_id IN (?)
      ORDER BY un.lido_em, u.id`,
    [interactionIds],
  );

  for (const row of rows) {
    const list = map.get(row.interaction_id) ?? [];
    if (!list.some((r) => r.id === row.id)) list.push(row);
    map.set(row.interaction_id, list);
  }
  return map;
}

/* ============================================================
 * Push (Expo Push API) — envio em lotes de 100
 * ============================================================ */

export interface PushMessage {
  title: string;
  body: string;
  data: Record<string, string>;
}

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

export async function sendPushToAll(messages: PushMessage[]): Promise<void> {
  if (messages.length === 0) return;
  try {
    const tokens = (await select<{ expo_push_token: string }>(
      "SELECT DISTINCT expo_push_token FROM user_push_tokens",
    )).map((t) => t.expo_push_token).filter(Boolean);
    if (tokens.length === 0) return;

    const payload = messages.flatMap((m) =>
      tokens.map((to) => ({ to, sound: "default", channelId: "default", ...m })),
    );

    const invalid = new Set<string>();
    for (let i = 0; i < payload.length; i += 100) {
      const chunk = payload.slice(i, i + 100);
      try {
        const response = await fetch(EXPO_PUSH_URL, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify(chunk),
          signal: AbortSignal.timeout(15_000),
        });
        const result = (await response.json()) as {
          data?: { status: string; details?: { error?: string }; message?: string }[];
          errors?: unknown[];
        };
        if (result.errors) logger.error({ errors: result.errors }, "Expo Push recusou o lote");
        result.data?.forEach((ticket, idx) => {
          if (ticket.status !== "error") return;
          if (ticket.details?.error === "DeviceNotRegistered") invalid.add(chunk[idx].to);
          else logger.warn({ error: ticket.details?.error, msg: ticket.message }, "Falha em push individual");
        });
      } catch (err) {
        logger.error({ err }, "Falha ao chamar Expo Push API");
      }
    }

    if (invalid.size > 0) {
      await exec("DELETE FROM user_push_tokens WHERE expo_push_token IN (?)", [[...invalid]]);
      logger.info({ count: invalid.size }, "Tokens de push inválidos removidos");
    }
    logger.info({ messages: messages.length, devices: tokens.length }, "Push enviado");
  } catch (err) {
    logger.error({ err }, "Erro ao enviar notificações push");
  }
}

/* ============================================================
 * Rotas
 * ============================================================ */

export const notificationsRouter = Router();
notificationsRouter.use(authenticate);

notificationsRouter.get("/", async (req, res) => {
  const rows = await select(
    `SELECT un.id AS user_notification_id, un.lido, un.lido_em,
            n.id AS notification_id, n.created_at AS notification_created_at,
            i.id AS interaction_id, i.tipo_evento, i.descricao_chamado, i.texto_evento,
            i.usuario_nome, i.usuario_email, i.data_evento,
            t.ticket_externo_id, t.empresa
       FROM user_notifications un
       JOIN notifications n ON n.id = un.notification_id
       JOIN interactions i ON i.id = n.interaction_id
       JOIN tickets t ON t.id = i.ticket_id
      WHERE un.user_id = ? AND un.lido = FALSE
      ORDER BY i.data_evento DESC`,
    [currentUser(req).id],
  );
  res.json(rows);
});

/** IDs externos dos tickets com notificações não lidas (payload enxuto para a Home). */
notificationsRouter.get("/unread-tickets", async (req, res) => {
  const rows = await select<{ ticket_externo_id: string }>(
    `SELECT DISTINCT t.ticket_externo_id
       FROM user_notifications un
       JOIN notifications n ON n.id = un.notification_id
       JOIN interactions i ON i.id = n.interaction_id
       JOIN tickets t ON t.id = i.ticket_id
      WHERE un.user_id = ? AND un.lido = FALSE`,
    [currentUser(req).id],
  );
  res.json(rows.map((r) => r.ticket_externo_id));
});

notificationsRouter.put("/ticket/:ticketId/read-all", async (req, res) => {
  const { ticketId } = parse(TicketParam, req.params);
  const result = await exec(
    `UPDATE user_notifications un
       JOIN notifications n ON n.id = un.notification_id
       JOIN interactions i ON i.id = n.interaction_id
       JOIN tickets t ON t.id = i.ticket_id
        SET un.lido = TRUE, un.lido_em = NOW()
      WHERE un.user_id = ? AND t.ticket_externo_id = ? AND un.lido = FALSE`,
    [currentUser(req).id, ticketId],
  );
  res.json({ success: true, updated: result.affectedRows });
});

notificationsRouter.put("/:id/read", async (req, res) => {
  const { id } = parse(IdParam, req.params);
  await exec(
    `UPDATE user_notifications SET lido = TRUE, lido_em = NOW()
      WHERE user_id = ? AND notification_id = ? AND lido = FALSE`,
    [currentUser(req).id, id],
  );
  res.json({ success: true });
});

notificationsRouter.get("/readers/:id", async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const readers = (await readersByInteraction([id])).get(id) ?? [];
  res.json(readers.map(({ id: userId, nome }) => ({ id: userId, nome })));
});
