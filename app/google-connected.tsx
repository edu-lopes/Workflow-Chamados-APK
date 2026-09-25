import { useRouter } from "expo-router";
import { useEffect } from "react";

/**
 * Destino do deep link fluxoemailschamados://google-connected (retorno do OAuth
 * no Android). A tela de login já trata o resultado; aqui só voltamos para ela.
 */
export default function GoogleConnected() {
  const router = useRouter();
  useEffect(() => {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }, [router]);
  return null;
}
