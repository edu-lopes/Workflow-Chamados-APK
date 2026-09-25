-- ==================================================================
--  001 — Índices para as consultas da API v2 (MariaDB 10.11)
--  Não altera dados nem colunas. Pode ser executada mais de uma vez.
--
--  Antes:  mysqldump -u root -p --single-transaction fluxo_workflow > backup_antes_001.sql
--  Rodar:  mysql -u root -p fluxo_workflow < 001_indices.sql
-- ==================================================================

-- interactions: listagem e detalhe buscam por ticket ordenando por data e
-- testam o tipo do último evento. O índice composto cobre tudo isso e
-- substitui o antigo KEY `ticket_id` (mesma coluna à esquerda, então a
-- FOREIGN KEY continua atendida).
ALTER TABLE `interactions`
  ADD INDEX IF NOT EXISTS `idx_ticket_data_tipo` (`ticket_id`, `data_evento`, `tipo_evento`);
ALTER TABLE `interactions`
  DROP INDEX IF EXISTS `ticket_id`;

-- user_notifications: "quem leu" filtra por notificação + lido = TRUE.
-- Substitui o KEY `notification_id` (FK continua atendida).
ALTER TABLE `user_notifications`
  ADD INDEX IF NOT EXISTS `idx_notification_lido` (`notification_id`, `lido`);
ALTER TABLE `user_notifications`
  DROP INDEX IF EXISTS `notification_id`;

-- user_push_tokens: remoção de tokens inválidos por valor do token.
ALTER TABLE `user_push_tokens`
  ADD INDEX IF NOT EXISTS `idx_push_token` (`expo_push_token`);

-- Atualiza estatísticas do otimizador
ANALYZE TABLE `interactions`, `user_notifications`, `notifications`, `tickets`, `user_push_tokens`;
