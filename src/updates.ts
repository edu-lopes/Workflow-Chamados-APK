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
