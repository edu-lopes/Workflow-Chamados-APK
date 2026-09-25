/**
 * Cliente único da API: URL configurável por build, token em armazenamento
 * seguro, timeout, mensagens de erro legíveis e cache para uso offline.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

/* ============================================================
 * URL da API
 * ============================================================ */

// EXPO_PUBLIC_* é embutido no bundle durante o build (eas.json -> build.<perfil>.env)
const RAW_URL = (process.env.EXPO_PUBLIC_API_URL ?? "").trim().replace(/\/+$/, "");
export const API_URL = RAW_URL || (__DEV__ ? "http://localhost:8080" : "");

if (!__DEV__ && API_URL.startsWith("http://")) {
  console.warn(`[api] API_URL usa HTTP (${API_URL}). Builds Android de produção bloqueiam HTTP sem TLS.`);
}

/* ============================================================
 * Tipos
 * ============================================================ */

export interface User {
  id: number;
  nome: string;
  email: string;
}

export interface Settings {
  iconColor: string;
  darkMode: boolean;
  fontSize: string;
}

export interface Reader {
  id: number;
  nome: string;
  email?: string;
  inicial?: string;
  icon_color?: string;
}

export interface Ticket {
  id: number;
  ticket_externo_id: string;
  empresa: string | null;
  assunto: string | null;
  descricao: string | null;
  data_criacao: string | null;
  total_interacoes: number;
  ultima_atualizacao: string | null;
  encerrado: boolean;
  finalizado: boolean;
  cancelado: boolean;
  leitores: Reader[];
}

export interface Interacao {
  tipo: string;
  autor: string | null;
  email: string | null;
  mensagem: string | null;
  data: string | null;
  lado: "datapar" | "apk";
  leitores: Reader[];
}

export interface TicketDetail {
  ticketId: string;
  empresa: string | null;
  assunto: string;
  descricao: string;
  encerrado: boolean;
  finalizado: boolean;
  cancelado: boolean;
  interacoes: Interacao[];
}

export interface SyncResult {
  message: string;
  results: { id: string; status: "processed" | "ignored" | "error"; error?: string }[];
}

/* ============================================================
 * Armazenamento seguro do token (Keystore/Keychain; web usa AsyncStorage)
 * ============================================================ */

const TOKEN_KEY = "auth_token";
let memoryToken: string | null = null;

export const tokenStore = {
  async load(): Promise<string | null> {
    memoryToken =
      Platform.OS === "web" ? await AsyncStorage.getItem(TOKEN_KEY) : await SecureStore.getItemAsync(TOKEN_KEY);
    return memoryToken;
  },
  async save(token: string): Promise<void> {
    memoryToken = token;
    if (Platform.OS === "web") await AsyncStorage.setItem(TOKEN_KEY, token);
    else await SecureStore.setItemAsync(TOKEN_KEY, token);
  },
  async clear(): Promise<void> {
    memoryToken = null;
    if (Platform.OS === "web") await AsyncStorage.removeItem(TOKEN_KEY);
    else await SecureStore.deleteItemAsync(TOKEN_KEY);
  },
};

/* ============================================================
 * Requisições
 * ============================================================ */

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

let onUnauthorized: (() => void) | null = null;
/** Registrado pela sessão: chamado quando a API responde 401 (token expirado). */
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  auth?: boolean;
  timeoutMs?: number;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, auth = true, timeoutMs = 20_000 } = opts;

  if (!API_URL) {
    throw new ApiError("App compilado sem EXPO_PUBLIC_API_URL. Configure a URL no eas.json e gere o build novamente.", 0, "NO_API_URL");
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth && memoryToken) headers.Authorization = `Bearer ${memoryToken}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = (err as Error)?.name === "AbortError";
    throw new ApiError(
      aborted
        ? `O servidor demorou demais para responder (${API_URL}).`
        : `Sem conexão com o servidor (${API_URL}). Verifique a internet ou se a API está no ar.`,
      0,
      aborted ? "TIMEOUT" : "NETWORK",
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // resposta não-JSON (ex.: página de erro do proxy)
  }

  if (!response.ok) {
    const payload = (data ?? {}) as { error?: string; code?: string };
    if (response.status === 401 && auth) onUnauthorized?.();
    throw new ApiError(
      payload.error ??
        (response.status === 502 || response.status === 503
          ? "Servidor indisponível no momento. Tente novamente em instantes."
          : `Erro ${response.status} ao acessar o servidor.`),
      response.status,
      payload.code,
    );
  }
  return data as T;
}

/* ============================================================
 * Cache (fallback offline)
 * ============================================================ */

const CACHE_PREFIX = "@cache:";

export const cache = {
  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await AsyncStorage.getItem(CACHE_PREFIX + key);
      return raw ? (JSON.parse(raw) as { data: T }).data : null;
    } catch {
      return null;
    }
  },
  async set<T>(key: string, data: T): Promise<void> {
    await AsyncStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ data, at: Date.now() })).catch(() => undefined);
  },
  async remove(key: string): Promise<void> {
    await AsyncStorage.removeItem(CACHE_PREFIX + key).catch(() => undefined);
  },
  async clear(): Promise<void> {
    const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(CACHE_PREFIX));
    if (keys.length) await AsyncStorage.multiRemove(keys);
  },
};

/** Busca na API e atualiza o cache; se estiver offline, devolve o último cache. */
async function withCache<T>(key: string, fetcher: () => Promise<T>): Promise<{ data: T; stale: boolean }> {
  try {
    const data = await fetcher();
    await cache.set(key, data);
    return { data, stale: false };
  } catch (err) {
    const isNetwork = err instanceof ApiError && (err.status === 0 || err.status >= 502);
    const cached = isNetwork ? await cache.get<T>(key) : null;
    if (cached !== null) return { data: cached, stale: true };
    throw err;
  }
}

/* ============================================================
 * Endpoints
 * ============================================================ */

export const api = {
  health: () => request<{ status: string }>("/health", { auth: false, timeoutMs: 8_000 }),

  login: (email: string, senha: string) =>
    request<{ user: User; token: string; settings: Settings }>("/users/login", {
      method: "POST",
      body: { email: email.trim(), senha },
      auth: false,
    }),

  settings: () => request<Settings>("/users/settings"),
  setIconColor: (color: string) => request("/users/settings/icon-color", { method: "PUT", body: { color } }),
  setDarkMode: (enabled: boolean) => request("/users/settings/dark-mode", { method: "PUT", body: { enabled } }),
  registerPushToken: (expoPushToken: string) =>
    request("/users/push-token", { method: "POST", body: { expoPushToken } }),
  unregisterPushToken: (expoPushToken: string) =>
    request("/users/push-token", { method: "DELETE", body: { expoPushToken }, timeoutMs: 5_000 }),

  tickets: () => withCache("tickets", () => request<Ticket[]>("/tickets")),
  ticket: (id: string) => withCache(`ticket_${id}`, () => request<TicketDetail>(`/tickets/${encodeURIComponent(id)}`)),
  unreadTicketIds: () => withCache("unread", () => request<string[]>("/notifications/unread-tickets")),
  markTicketRead: (id: string) =>
    request(`/notifications/ticket/${encodeURIComponent(id)}/read-all`, { method: "PUT" }),

  sync: () => request<SyncResult>("/sync", { method: "POST", timeoutMs: 120_000 }),
  googleAuthUrl: (redirect?: string) =>
    request<{ url: string }>(`/auth/google${redirect ? `?redirect=${encodeURIComponent(redirect)}` : ""}`),
};
