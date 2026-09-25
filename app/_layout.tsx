import { useFonts } from "expo-font";
import { Stack, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import React, { useEffect } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { usePushNotifications } from "@/src/push";
import { SessionProvider, useSession } from "@/src/session";

SplashScreen.preventAutoHideAsync().catch(() => undefined);

// Rotas acessíveis sem login
const PUBLIC_ROUTES = new Set(["login", "google-connected"]);

/** Redireciona conforme o estado da sessão e libera a splash quando pronto. */
function AppShell() {
  const { status, darkMode } = useSession();
  const segments = useSegments();
  const router = useRouter();
  usePushNotifications();

  useEffect(() => {
    if (status === "loading") return;
    SplashScreen.hideAsync().catch(() => undefined);
    const first = segments[0] as string | undefined;
    if (status === "signedOut" && first && !PUBLIC_ROUTES.has(first)) {
      router.replace("/login");
    }
  }, [status, segments, router]);

  return (
    <>
      <StatusBar style={darkMode ? "light" : "dark"} />
      <Stack screenOptions={{ headerShown: false, animation: "slide_from_right" }} />
    </>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Manrope: require("../assets/fonts/Manrope-Regular.ttf"),
    ManropeLight: require("../assets/fonts/Manrope-Light.ttf"),
    ManropeMedium: require("../assets/fonts/Manrope-Medium.ttf"),
    ManropeSemiBold: require("../assets/fonts/Manrope-SemiBold.ttf"),
    ManropeBold: require("../assets/fonts/Manrope-Bold.ttf"),
    ManropeExtraBold: require("../assets/fonts/Manrope-ExtraBold.ttf"),
  });

  // Se a fonte falhar, segue com a fonte do sistema em vez de travar na splash
  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <SessionProvider>
        <AppShell />
      </SessionProvider>
    </SafeAreaProvider>
  );
}
