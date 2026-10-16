/**
 * Tickets: listagem (Home) e detalhe com interações (chat).
 * Rotas montadas em /tickets. Todas exigem autenticação.
 */
import { Router } from "express";
import { z } from "zod";
import { authenticate, env, formatDateTime, HttpError, parse, select } from "../core";
import { readersByInteraction } from "./notifications";

const TicketParam = z.object({ ticketId: z.string().trim().min(1).max(50) });
const CLOSING_TYPES = new Set(["pre_encerramento", "encerramento"]);

const isBlank = (v: string | null | undefined) => v === null || v === undefined || v.trim() === "";

/** Lado do chat: e-mails dos domínios internos ficam do lado "apk". */
function sideOf(email: string | null): "apk" | "datapar" {
  const domain = email?.split("@")[1]?.toLowerCase().trim();
  return domain && env.INTERNAL_EMAIL_DOMAINS.includes(domain) ? "apk" : "datapar";
}

interface ListRow {
  id: number;
  ticket_externo_id: string;
  empresa: string | null;
  assunto: string | null;
  total_interacoes: number;
  data_criacao: Date | null;
  ultima_atualizacao: Date | null;
  last_interaction_id: number;
  descricao: string | null;
  ultimo_tipo: string | null;
  ultimo_texto: string | null;
  encerrado: number;
  cancelado: number;
}

export const ticketsRouter = Router();
ticketsRouter.use(authenticate);

ticketsRouter.get("/", async (_req, res) => {
  // Agregados calculados uma única vez por ticket (antes eram ~10 subconsultas
  // correlacionadas por linha). Tickets recentes saem de idx_data_evento; as
  // buscas por ticket usam idx_ticket_data_tipo (ver database/migrations).
  // "Primeira" e "última" interação têm desempate determinístico (data_evento, id).
  const rows = await select<ListRow>(
    `SELECT t.id, t.ticket_externo_id, t.empresa, t.assunto,
            agg.total_interacoes, agg.data_criacao, agg.ultima_atualizacao,
            agg.last_interaction_id,
            fi.descricao_chamado AS descricao,
            li.tipo_evento AS ultimo_tipo,
            li.texto_evento AS ultimo_texto,
            EXISTS (SELECT 1 FROM interactions x
                     WHERE x.ticket_id = t.id AND x.data_evento = agg.ultima_atualizacao
                       AND x.tipo_evento IN ('pre_encerramento', 'encerramento')) AS encerrado,
            EXISTS (SELECT 1 FROM interactions x
                     WHERE x.ticket_id = t.id AND x.data_evento = agg.ultima_atualizacao
                       AND x.tipo_evento = 'cancelamento') AS cancelado
       FROM (SELECT ticket_id,
                    COUNT(*)         AS total_interacoes,
                    MIN(data_evento) AS data_criacao,
                    MAX(data_evento) AS ultima_atualizacao,
                    MAX(id)          AS last_interaction_id
               FROM interactions
              WHERE ticket_id IN (SELECT ticket_id FROM interactions
                                   WHERE data_evento >= NOW() - INTERVAL ? MONTH)
              GROUP BY ticket_id) agg
       JOIN tickets t ON t.id = agg.ticket_id
       LEFT JOIN interactions fi ON fi.id = (
             SELECT f.id FROM interactions f WHERE f.ticket_id = t.id
              ORDER BY f.data_evento ASC, f.id ASC LIMIT 1)
       LEFT JOIN interactions li ON li.id = (
             SELECT l.id FROM interactions l WHERE l.ticket_id = t.id
              ORDER BY l.data_evento DESC, l.id DESC LIMIT 1)
      ORDER BY agg.ultima_atualizacao DESC`,
    [env.TICKETS_MONTHS],
  );

  const readers = await readersByInteraction(rows.map((r) => r.last_interaction_id));

  res.json(
    rows.map((r) => ({
      id: r.id,
      ticket_externo_id: r.ticket_externo_id,
      empresa: r.empresa,
      assunto: r.assunto,
      descricao: r.descricao,
      data_criacao: formatDateTime(r.data_criacao),
      total_interacoes: Number(r.total_interacoes),
      ultima_atualizacao: formatDateTime(r.ultima_atualizacao),
      encerrado: Number(r.encerrado) === 1,
      finalizado: r.ultimo_tipo === "finalizacao",
      cancelado: Number(r.cancelado) === 1,
      leitores: (readers.get(r.last_interaction_id) ?? []).map(({ id, nome, icon_color }) => ({
        id,
        nome,
        icon_color,
      })),
    })),
  );
});

interface InteractionRow {
  id: number;
  tipo_evento: string;
  descricao_chamado: string | null;
  texto_evento: string | null;
  usuario_nome: string | null;
  usuario_email: string | null;
  data_evento: Date;
}

ticketsRouter.get("/:ticketId", async (req, res) => {
  const { ticketId } = parse(TicketParam, req.params);

  const [ticket] = await select<{ id: number; ticket_externo_id: string; empresa: string | null; assunto: string | null }>(
    "SELECT id, ticket_externo_id, empresa, assunto FROM tickets WHERE ticket_externo_id = ? LIMIT 1",
    [ticketId],
  );
  if (!ticket) throw new HttpError(404, "Ticket não encontrado", "NOT_FOUND");

  const interactions = await select<InteractionRow>(
    `SELECT id, tipo_evento, descricao_chamado, texto_evento, usuario_nome, usuario_email, data_evento
       FROM interactions WHERE ticket_id = ?
      ORDER BY data_evento ASC, id ASC`,
    [ticket.id],
  );

  // Uma consulta para os leitores de todas as interações (antes: 2 por interação)
  const readers = await readersByInteraction(interactions.map((i) => i.id));

  const last = interactions[interactions.length - 1];
  const interacoes = interactions.map((i) => {
    let mensagem = i.tipo_evento === "abertura" ? i.descricao_chamado : i.texto_evento;
    if (i.tipo_evento === "pre_encerramento" && !mensagem) mensagem = "O chamado foi encerrado pelo sistema";
    if (i.tipo_evento === "finalizacao") mensagem = "O chamado foi finalizado";
    if (i.tipo_evento !== "abertura" && isBlank(mensagem)) mensagem = "(Interação sem texto)";
    return {
      tipo: i.tipo_evento,
      autor: i.usuario_nome,
      email: i.usuario_email,
      mensagem,
      data: formatDateTime(i.data_evento),
      lado: sideOf(i.usuario_email),
      leitores: (readers.get(i.id) ?? []).map((r) => ({
        id: r.id,
        nome: r.nome,
        email: r.email,
        inicial: r.nome.charAt(0).toUpperCase(),
        icon_color: r.icon_color,
      })),
    };
  });

  res.json({
    ticketId: ticket.ticket_externo_id,
    empresa: ticket.empresa,
    assunto: ticket.assunto ?? "",
    descricao: interactions.find((i) => i.descricao_chamado)?.descricao_chamado ?? "",
    interacoes,
    encerrado: !!last && CLOSING_TYPES.has(last.tipo_evento),
    finalizado: last?.tipo_evento === "finalizacao",
    cancelado: last?.tipo_evento === "cancelamento",
  });
});
