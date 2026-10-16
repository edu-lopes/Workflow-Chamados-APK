/**
 * Notificações push: permissão, canal Android, registro do token no backend
 * (somente com usuário logado) e navegação ao tocar na notificação.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { useEffect } from "react";
import { Platform } from "react-native";
import { api } from "./api";
import { PUSH_TOKEN_KEY, useSession } from "./session";

const PENDING_TICKET_KEY = "@push:pendingTicket";
const PENDING_ACTION_KEY = "@push:pendingAction";
const HANDLED_KEY = "@push:lastHandled";

if (Platform.OS !== "web") {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: true,
      shouldSetBadge: true,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

async function getExpoPushToken(): Promise<string | null> {
  if (Platform.OS === "web" || !Device.isDevice) return null;

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "Chamados",
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#e50d3b",
    });
  }

  let { status } = await Notifications.getPermissionsAsync();
  if (status !== "granted") status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== "granted") return null;

  // projectId é obrigatório em builds standalone (APK); sem ele o token falha
  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
  return data;
}

/** Ação especial enviada pelo servidor (ex.: "google_reauth" quando a sincronização parou). */
function actionFrom(response: Notifications.NotificationResponse): string | null {
  const action = (response.notification.request.content.data as { action?: unknown } | undefined)?.action;
  return action ? String(action) : null;
}

/** Retorna (e limpa) a ação pendente vinda de uma notificação. */
export async function takePendingAction(): Promise<string | null> {
  const action = await AsyncStorage.getItem(PENDING_ACTION_KEY);
  if (action) await AsyncStorage.removeItem(PENDING_ACTION_KEY);
  return action;
}

function ticketIdFrom(response: Notifications.NotificationResponse): string | null {
  const id = (response.notification.request.content.data as { ticketId?: unknown } | undefined)?.ticketId;
  return id ? String(id) : null;
}

/** Guarda o ticket para abrir depois (app fechado ou usuário deslogado). */
async function rememberTicket(ticketId: string) {
  await AsyncStorage.setItem(PENDING_TICKET_KEY, ticketId);
}

/** Retorna (e limpa) o ticket pendente vindo de uma notificação. */
export async function takePendingTicket(): Promise<string | null> {
  const id = await AsyncStorage.getItem(PENDING_TICKET_KEY);
  if (id) await AsyncStorage.removeItem(PENDING_TICKET_KEY);
  return id;
}

/** Remove da bandeja as notificações já exibidas de um ticket. */
export async function dismissTicketNotifications(ticketId: string) {
  if (Platform.OS === "web") return;
  try {
    const presented = await Notifications.getPresentedNotificationsAsync();
    await Promise.all(
      presented
        .filter((n) => String((n.request.content.data as { ticketId?: unknown })?.ticketId) === ticketId)
        .map((n) => Notifications.dismissNotificationAsync(n.request.identifier)),
    );
  } catch (err) {
    console.warn("[push] falha ao limpar notificações", err);
  }
}

/** Montado uma vez no layout raiz. */
export function usePushNotifications() {
  const { status } = useSession();

  // Registra o token quando houver usuário logado
  useEffect(() => {
    if (status !== "signedIn" || Platform.OS === "web") return;
    (async () => {
      try {
        const token = await getExpoPushToken();
        if (!token) return;
        await api.registerPushToken(token);
        await AsyncStorage.setItem(PUSH_TOKEN_KEY, token);
      } catch (err) {
        console.warn("[push] registro falhou", err);
      }
    })();
  }, [status]);

  // Toque em notificação: app aberto -> navega; app fechado -> guarda para a Home abrir
  useEffect(() => {
    if (Platform.OS === "web") return;

    (async () => {
      const last = await Notifications.getLastNotificationResponseAsync();
      if (!last) return;
      const handled = await AsyncStorage.getItem(HANDLED_KEY);
      if (handled === last.notification.request.identifier) return;
      await AsyncStorage.setItem(HANDLED_KEY, last.notification.request.identifier);
      const action = actionFrom(last);
      if (action) await AsyncStorage.setItem(PENDING_ACTION_KEY, action);
      const ticketId = ticketIdFrom(last);
      if (ticketId) await rememberTicket(ticketId);
    })();

    const sub = Notifications.addNotificationResponseReceivedListener(async (response) => {
      await AsyncStorage.setItem(HANDLED_KEY, response.notification.request.identifier);
      const action = actionFrom(response);
      if (action === "google_reauth" && status === "signedIn") {
        router.navigate({ pathname: "/login", params: { google: "reauth" } });
        return;
      }
      if (action) {
        await AsyncStorage.setItem(PENDING_ACTION_KEY, action);
        return;
      }
      const ticketId = ticketIdFrom(response);
      if (!ticketId) return;
      if (status === "signedIn") {
        router.navigate({ pathname: "/ticket/[id]", params: { id: ticketId } });
      } else {
        await rememberTicket(ticketId);
      }
    });
    return () => sub.remove();
  }, [status]);
}
