/**
 * Atualizações "pelo ar" (EAS Update): ao abrir o app e ao voltar para ele,
 * verifica se há versão nova do código, baixa em segundo plano e pergunta
 * se pode reiniciar. Sem rede ou sem novidade, nada acontece.
 */
import * as Updates from "expo-updates";
import { useEffect, useRef } from "react";
import { Alert, AppState } from "react-native";

const CHECK_INTERVAL_MS = 10 * 60 * 1000; // no máximo 1 verificação a cada 10 min

export function useOtaUpdates() {
  const lastCheck = useRef(0);
  const busy = useRef(false);

  useEffect(() => {
    if (__DEV__ || !Updates.isEnabled) return;

    const check = async () => {
      if (busy.current || Date.now() - lastCheck.current < CHECK_INTERVAL_MS) return;
      busy.current = true;
      lastCheck.current = Date.now();
      try {
        const { isAvailable } = await Updates.checkForUpdateAsync();
        if (!isAvailable) return;
        const { isNew } = await Updates.fetchUpdateAsync();
        if (!isNew) return;
        Alert.alert("Atualização disponível", "Uma nova versão do app foi baixada. Reiniciar agora para aplicar?", [
          { text: "Depois", style: "cancel" }, // aplica sozinho na próxima abertura
          { text: "Reiniciar", onPress: () => Updates.reloadAsync().catch(() => undefined) },
        ]);
      } catch (err) {
        console.warn("[updates] falha ao verificar atualização", err);
      } finally {
        busy.current = false;
      }
    };

    check();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") check();
    });
    return () => sub.remove();
  }, []);
}

/** Texto curto da versão em uso, para exibir em Configurações. */
export function versionLabel(appVersion: string | undefined): string {
  const base = `Versão ${appVersion ?? "-"}`;
  if (__DEV__ || !Updates.isEnabled || Updates.isEmbeddedLaunch || !Updates.createdAt) return base;
  const d = Updates.createdAt;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${base} · atualização de ${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Verificação manual (botão em Configurações): mostra o diagnóstico completo
 * e, se houver atualização, baixa e oferece reiniciar.
 */
export async function checkForUpdatesNow(): Promise<void> {
  const info = [
    `Canal: ${Updates.channel ?? "(nenhum)"}`,
    `Versão de runtime: ${Updates.runtimeVersion ?? "(nenhuma)"}`,
    `Em uso: ${Updates.isEmbeddedLaunch ? "código do APK" : `atualização ${Updates.updateId?.slice(0, 8)}`}`,
  ].join("\n");

  if (__DEV__ || !Updates.isEnabled) {
    Alert.alert(
      "Atualizações desativadas",
      "Este app não recebe atualizações pelo ar (modo de desenvolvimento ou APK gerado antes do recurso). Instale um APK novo.",
    );
    return;
  }
  try {
    const { isAvailable } = await Updates.checkForUpdateAsync();
    if (!isAvailable) {
      Alert.alert("Nenhuma atualização", `O app já está na versão mais recente publicada para este canal.\n\n${info}`);
      return;
    }
    await Updates.fetchUpdateAsync();
    Alert.alert("Atualização baixada", `Reiniciar agora para aplicar?\n\n${info}`, [
      { text: "Depois", style: "cancel" },
      { text: "Reiniciar", onPress: () => Updates.reloadAsync().catch(() => undefined) },
    ]);
  } catch (err) {
    Alert.alert("Falha ao verificar", `${err instanceof Error ? err.message : String(err)}\n\n${info}`);
  }
}
