/**
 * Atualizações "pelo ar" (EAS Update).
 *
 * - `useOtaUpdates()` (montado no layout raiz) observa o ESTADO do atualizador
 *   nativo. Sempre que houver uma atualização baixada e ainda não aplicada,
 *   mostra o aviso "Reiniciar?" — em qualquer tela, inclusive o login.
 *   Isso cobre também o download que o próprio Android faz ao abrir o app.
 * - `checkForUpdatesSilently()` procura e baixa em segundo plano; chamada ao
 *   abrir o app, ao voltar para ele, no login e sempre que a Home recarrega.
 * - `checkForUpdatesNow()` é o botão de Configurações: mesmo fluxo, com retorno
 *   visível (diagnóstico quando não há novidade ou em caso de erro).
 */
import * as Updates from "expo-updates";
import { useEffect } from "react";
import { Alert, AppState } from "react-native";

const enabled = !__DEV__ && Updates.isEnabled;
const MIN_INTERVAL_MS = 30 * 1000; // evita verificações repetidas em sequência

let lastCheckAt = 0;
let inFlight: Promise<string | null> | null = null;

/* ---------------- Aviso "Reiniciar?" (um por vez) ---------------- */

let promptOpen = false;
const dismissedIds = new Set<string>(); // "Depois" nesta sessão: não insiste no automático

function promptRestart(updateId: string, force: boolean) {
  if (promptOpen) return;
  if (!force && dismissedIds.has(updateId)) return;
  promptOpen = true;
  Alert.alert(
    "Atualização disponível",
    "Uma nova versão do app foi baixada. Reiniciar agora para aplicar?",
    [
      {
        text: "Depois",
        style: "cancel",
        onPress: () => {
          promptOpen = false;
          dismissedIds.add(updateId); // será aplicada sozinha na próxima abertura
        },
      },
      {
        text: "Reiniciar",
        onPress: () => {
          promptOpen = false;
          Updates.reloadAsync().catch(() => undefined);
        },
      },
    ],
    {
      cancelable: true,
      onDismiss: () => {
        promptOpen = false;
        dismissedIds.add(updateId);
      },
    },
  );
}

/* ---------------- Verificação ---------------- */

/** Procura e baixa a atualização. Retorna o id da versão nova (baixada agora ou antes) ou null. */
async function checkAndFetch(): Promise<string | null> {
  const { isAvailable } = await Updates.checkForUpdateAsync();
  if (!isAvailable) return null;
  const { manifest } = await Updates.fetchUpdateAsync(); // se já estava baixada, não baixa de novo
  return String((manifest as { id?: string } | undefined)?.id ?? "pendente");
}

/** Verificação silenciosa (sem mensagens). O aviso aparece pelo `useOtaUpdates`. */
export function checkForUpdatesSilently(): void {
  if (!enabled || inFlight || Date.now() - lastCheckAt < MIN_INTERVAL_MS) return;
  lastCheckAt = Date.now();
  inFlight = checkAndFetch()
    .catch((err) => {
      console.warn("[updates] falha ao verificar atualização", err);
      return null;
    })
    .finally(() => {
      inFlight = null;
    });
}

/** Hook do layout raiz: verifica ao abrir/voltar ao app e mostra o aviso quando houver versão baixada. */
export function useOtaUpdates() {
  const { isUpdatePending, downloadedUpdate } = Updates.useUpdates();
  const pendingId = isUpdatePending ? downloadedUpdate?.updateId : undefined;

  useEffect(() => {
    if (!enabled) return;
    checkForUpdatesSilently();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") checkForUpdatesSilently();
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (enabled && pendingId) promptRestart(pendingId, false);
  }, [pendingId]);
}

/* ---------------- Botão "Verificar atualizações" ---------------- */

function diagnostico(): string {
  return [
    `Canal: ${Updates.channel ?? "(nenhum)"}`,
    `Versão de runtime: ${Updates.runtimeVersion ?? "(nenhuma)"}`,
    `Em uso: ${Updates.isEmbeddedLaunch ? "código do APK" : `atualização ${Updates.updateId?.slice(0, 8)}`}`,
  ].join("\n");
}

/** Verificação manual com retorno visível. Resolve quando termina (para o botão parar de girar). */
export async function checkForUpdatesNow(): Promise<void> {
  if (!enabled) {
    Alert.alert(
      "Atualizações desativadas",
      "Este app não recebe atualizações pelo ar (modo de desenvolvimento ou APK gerado antes do recurso). Instale um APK novo.",
    );
    return;
  }
  try {
    if (inFlight) await inFlight; // aproveita uma verificação automática em andamento
    lastCheckAt = Date.now();
    const updateId = await checkAndFetch();
    if (!updateId) {
      Alert.alert("Nenhuma atualização", `O app já está na versão mais recente publicada.\n\n${diagnostico()}`);
      return;
    }
    promptRestart(updateId, true);
  } catch (err) {
    Alert.alert("Falha ao verificar", `${err instanceof Error ? err.message : String(err)}\n\n${diagnostico()}`);
  }
}

/** Texto curto da versão em uso, para exibir em Configurações. */
export function versionLabel(appVersion: string | undefined): string {
  const base = `Versão ${appVersion ?? "-"}`;
  if (!enabled || Updates.isEmbeddedLaunch || !Updates.createdAt) return base;
  const d = Updates.createdAt;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${base} · atualização de ${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
