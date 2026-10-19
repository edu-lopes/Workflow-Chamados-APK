-- ==================================================================
--  002 — Corrige interações gravadas com o "Texto do Evento" errado
--
--  Até a versão anterior, quando o e-mail vinha com "Texto do Evento :" VAZIO,
--  a API gravava a linha seguinte ("Usuario Interação : Fulano (email)") como
--  se fosse o texto. Esta migração:
--    1) Interação sem texto do Suporte APK ou de Cleberson Santos -> tipo 'finalizacao' (chamado finalizado)
--    2) Demais interações com o mesmo erro          -> texto vazio (NULL)
--  Altera apenas dados (nenhuma coluna/tabela). Pode ser executada mais de uma vez.
--
--  Antes:  mysqldump -h 127.0.0.1 -u root -p --single-transaction fluxo_workflow > ~/backup_antes_002.sql
--  Prévia: veja o SELECT abaixo (o que será alterado)
--  Rodar:  mysql -h 127.0.0.1 -u root -p fluxo_workflow < 002_corrige_texto_vazio.sql
--
--  Obs.: o padrão encontra "Usuario"/"Usuário", com ou sem espaços/quebras de
--        linha antes, seguido de "Interação" ou "Pré-Encerramento".
-- ==================================================================

-- Prévia
SELECT i.id, t.ticket_externo_id AS ticket, i.data_evento, i.usuario_nome,
       LEFT(i.texto_evento, 60) AS texto_gravado,
       CASE WHEN i.usuario_nome IN ('Suporte APK', 'Cleberson Santos') OR i.usuario_email = 'suporte@apklog.com.br'
            THEN 'vira FINALIZACAO' ELSE 'texto -> vazio' END AS acao
  FROM interactions i
  JOIN tickets t ON t.id = i.ticket_id
 WHERE i.tipo_evento = 'interacao'
   AND i.texto_evento REGEXP '^[[:space:]]*Usu.rio[[:space:]]+(Intera|Pr)'
 ORDER BY i.data_evento;

START TRANSACTION;

-- 1) Finalizações (usuários de finalização = Suporte APK e Cleberson Santos)
UPDATE interactions
   SET tipo_evento = 'finalizacao', texto_evento = NULL
 WHERE tipo_evento = 'interacao'
   AND texto_evento REGEXP '^[[:space:]]*Usu.rio[[:space:]]+(Intera|Pr)'
   AND (usuario_nome IN ('Suporte APK', 'Cleberson Santos') OR usuario_email = 'suporte@apklog.com.br');

-- 2) Demais interações com o mesmo erro: só limpa o texto
UPDATE interactions
   SET texto_evento = NULL
 WHERE tipo_evento = 'interacao'
   AND texto_evento REGEXP '^[[:space:]]*Usu.rio[[:space:]]+(Intera|Pr)';

COMMIT;

-- Conferência: deve vir vazio
SELECT COUNT(*) AS restantes_com_erro
  FROM interactions
 WHERE texto_evento REGEXP '^[[:space:]]*Usu.rio[[:space:]]+(Intera|Pr)';
