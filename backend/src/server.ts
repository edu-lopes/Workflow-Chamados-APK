/**
 * Ponto de entrada: valida ambiente, conecta ao banco, sobe o HTTP,
 * agenda a sincronização e encerra de forma limpa (systemd SIGTERM).
 */
import { createApp } from "./app";
import { env, logger, pool, waitForDatabase } from "./core";
import { startScheduler, stopScheduler } from "./modules/gmail";

process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "Promise rejeitada sem tratamento");
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Exceção não capturada");
  process.exit(1);
});

async function main() {
  logger.info({ node: process.version, env: env.NODE_ENV, tz: env.APP_TIMEZONE }, "Iniciando API");
  await waitForDatabase();

  const server = createApp().listen(env.PORT, env.HOST, () => {
    logger.info(`API ouvindo em http://${env.HOST}:${env.PORT}`);
  });
  server.on("error", (err) => {
    logger.fatal({ err }, "Não foi possível abrir a porta HTTP");
    process.exit(1);
  });
  // Mantém conexões keep-alive além do timeout do proxy reverso
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  startScheduler();

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, "Encerrando...");
    stopScheduler();
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    server.close(async () => {
      await pool.end().catch(() => undefined);
      logger.info("Encerrado");
      process.exit(0);
    });
    server.closeIdleConnections();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err }, "Falha ao iniciar a API");
  process.exit(1);
});
