/**
 * Sessão do usuário + preferências visuais (substitui ThemeContext e os
 * vários AsyncStorage espalhados). Único ponto que sabe logar/deslogar.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, cache, setUnauthorizedHandler, tokenStore, type Settings, type User } from "./api";

const USER_KEY = "@session:user";
const SETTINGS_KEY = "@session:settings";
export const PUSH_TOKEN_KEY = "@push:token";
export const DEFAULT_ICON_COLOR = "#255088";

type Status = "loading" | "signedOut" | "signedIn";

interface SessionContextValue {
  status: Status;
  user: User | null;
  darkMode: boolean;
  iconColor: string;
  signIn: (email: string, senha: string) => Promise<User>;
  signOut: () => Promise<void>;
  toggleDarkMode: () => Promise<void>;
  saveIconColor: (color: string) => Promise<void>;
  refreshSettings: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession precisa estar dentro de <SessionProvider>");
  return ctx;
}

const DEFAULT_SETTINGS: Settings = { iconColor: DEFAULT_ICON_COLOR, darkMode: false, fontSize: "medium" };

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [user, setUser] = useState<User | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const applySettings = useCallback(async (s: Settings) => {
    settingsRef.current = s;
    setSettings(s);
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(s)).catch(() => undefined);
  }, []);

  const clearLocal = useCallback(async () => {
    await tokenStore.clear();
    await AsyncStorage.multiRemove([USER_KEY, SETTINGS_KEY]).catch(() => undefined);
    await cache.clear().catch(() => undefined);
    setUser(null);
    setSettings(DEFAULT_SETTINGS);
    setStatus("signedOut");
  }, []);

  const refreshSettings = useCallback(async () => {
    try {
      await applySettings(await api.settings());
    } catch {
      // mantém as preferências locais se estiver offline
    }
  }, [applySettings]);

  // Restaura a sessão salva ao abrir o app
  useEffect(() => {
    (async () => {
      try {
        const [token, rawUser, rawSettings] = await Promise.all([
          tokenStore.load(),
          AsyncStorage.getItem(USER_KEY),
          AsyncStorage.getItem(SETTINGS_KEY),
        ]);
        if (token && rawUser) {
          setUser(JSON.parse(rawUser));
          if (rawSettings) setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(rawSettings) });
          setStatus("signedIn");
          refreshSettings();
        } else {
          setStatus("signedOut");
        }
      } catch (err) {
        console.warn("[session] falha ao restaurar sessão", err);
        setStatus("signedOut");
      }
    })();
  }, [refreshSettings]);

  // Token expirado/inválido em qualquer requisição -> volta para o login
  useEffect(() => {
    setUnauthorizedHandler(() => {
      clearLocal();
    });
    return () => setUnauthorizedHandler(null);
  }, [clearLocal]);

  const signIn = useCallback(
    async (email: string, senha: string) => {
      const data = await api.login(email, senha);
      await tokenStore.save(data.token);
      await AsyncStorage.setItem(USER_KEY, JSON.stringify(data.user));
      await applySettings(data.settings ?? DEFAULT_SETTINGS);
      setUser(data.user);
      setStatus("signedIn");
      return data.user;
    },
    [applySettings],
  );

  const signOut = useCallback(async () => {
    // Para de receber push neste aparelho (melhor esforço; não bloqueia o logout)
    const pushToken = await AsyncStorage.getItem(PUSH_TOKEN_KEY);
    if (pushToken) await api.unregisterPushToken(pushToken).catch(() => undefined);
    await clearLocal();
  }, [clearLocal]);

  const toggleDarkMode = useCallback(async () => {
    const previous = settingsRef.current;
    const next = { ...previous, darkMode: !previous.darkMode };
    await applySettings(next);
    try {
      await api.setDarkMode(next.darkMode);
    } catch (err) {
      await applySettings(previous);
      throw err;
    }
  }, [applySettings]);

  const saveIconColor = useCallback(
    async (color: string) => {
      const previous = settingsRef.current;
      await applySettings({ ...previous, iconColor: color });
      try {
        await api.setIconColor(color);
      } catch (err) {
        await applySettings(previous);
        throw err;
      }
    },
    [applySettings],
  );

  const value = useMemo<SessionContextValue>(
    () => ({
      status,
      user,
      darkMode: settings.darkMode,
      iconColor: settings.iconColor || DEFAULT_ICON_COLOR,
      signIn,
      signOut,
      toggleDarkMode,
      saveIconColor,
      refreshSettings,
    }),
    [status, user, settings, signIn, signOut, toggleDarkMode, saveIconColor, refreshSettings],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
