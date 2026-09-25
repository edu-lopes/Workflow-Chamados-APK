import * as Linking from "expo-linking";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as WebBrowser from "expo-web-browser";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { api, API_URL, ApiError } from "@/src/api";
import { useSession } from "@/src/session";
import { BRAND_RED } from "@/src/ui";

type Etapa = "login" | "google_auth" | "sync";

const errorMessage = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback;

export default function LoginScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ google?: string }>();
  const { signIn, status } = useSession();

  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState("");
  const [etapa, setEtapa] = useState<Etapa>("login");
  const senhaRef = useRef<TextInput>(null);

  const goHome = useCallback(() => router.replace("/home"), [router]);

  /** Sincroniza e-mails; se o Google não estiver conectado, pede autorização. */
  const runSync = useCallback(async () => {
    setErro("");
    setLoading(true);
    try {
      await api.sync();
      goHome();
    } catch (err) {
      if (err instanceof ApiError && err.code === "GOOGLE_NOT_CONNECTED") {
        setEtapa("google_auth");
      } else if (etapa === "login") {
        // Falha de sincronização não impede o uso do app
        goHome();
        Alert.alert("Sincronização", errorMessage(err, "Não foi possível sincronizar agora."));
      } else {
        setErro(errorMessage(err, "Erro ao sincronizar"));
        setEtapa("sync");
      }
    } finally {
      setLoading(false);
    }
  }, [etapa, goHome]);

  // ?google=reauth (vindo da Home) ou ?google=connected (retorno do Google na web)
  useEffect(() => {
    if (params.google === "reauth" && status === "signedIn") {
      setEtapa("google_auth");
    } else if (params.google === "connected" && status === "signedIn") {
      if (Platform.OS === "web") window.history.replaceState({}, document.title, window.location.pathname);
      setEtapa("sync");
      runSync();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.google, status]);

  const fazerLogin = async () => {
    if (!email.trim() || !senha) {
      setErro("Informe e-mail e senha.");
      return;
    }
    setErro("");
    setLoading(true);
    try {
      await signIn(email, senha);
    } catch (err) {
      setErro(errorMessage(err, "Não foi possível conectar ao servidor"));
      setLoading(false);
      return;
    }
    setSenha("");
    await runSync();
  };

  const conectarGoogle = async () => {
    setErro("");
    setLoading(true);
    try {
      if (Platform.OS === "web") {
        const redirect = window.location.origin + window.location.pathname;
        const { url } = await api.googleAuthUrl(redirect);
        window.location.href = url;
        return;
      }
      const redirect = Linking.createURL("google-connected");
      const { url } = await api.googleAuthUrl(redirect);
      const result = await WebBrowser.openAuthSessionAsync(url, redirect);
      setEtapa("sync");
      if (result.type === "success") {
        await runSync();
        return;
      }
    } catch (err) {
      setErro(errorMessage(err, "Falha ao abrir autorização Google"));
      setEtapa("google_auth");
    }
    setLoading(false);
  };

  const testarConexao = async () => {
    try {
      const res = await api.health();
      Alert.alert("Servidor", `Conectado a ${API_URL}\nStatus: ${res.status}`);
    } catch (err) {
      Alert.alert("Servidor", errorMessage(err, "Falha ao conectar"));
    }
  };

  const logo = (
    <Image source={require("../assets/images/apk/logomarcaAPK.png")} style={styles.icone} resizeMode="contain" />
  );

  if (etapa !== "login") {
    const isAuth = etapa === "google_auth";
    return (
      <View style={styles.container}>
        <StatusBar style="light" />
        {logo}
        <Text style={styles.mensagem}>
          {isAuth
            ? "Para sincronizar seus chamados, conecte a conta Google."
            : "Após autorizar no navegador, toque abaixo para sincronizar."}
        </Text>
        <TouchableOpacity
          style={styles.botao}
          onPress={isAuth ? conectarGoogle : runSync}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.textoBotao}>{isAuth ? "Conectar Google" : "Sincronizar agora"}</Text>
          )}
        </TouchableOpacity>
        {!isAuth && !loading && (
          <Pressable onPress={() => setEtapa("google_auth")}>
            <Text style={styles.link}>Autorizar novamente</Text>
          </Pressable>
        )}
        {erro ? <Text style={styles.erroGoogle}>{erro}</Text> : null}
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={styles.container}>
        <StatusBar style="light" />
        {logo}
        <Text style={styles.inicio}>Realize o Login para acessar...</Text>

        {erro !== "" && (
          <View style={styles.erroContainer}>
            <Text style={styles.erroTexto}>{erro}</Text>
          </View>
        )}

        <TextInput
          placeholder="Email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="username"
          autoComplete="email"
          returnKeyType="next"
          onSubmitEditing={() => senhaRef.current?.focus()}
          style={styles.input}
          editable={!loading}
        />
        <TextInput
          ref={senhaRef}
          placeholder="Senha"
          value={senha}
          onChangeText={setSenha}
          secureTextEntry
          textContentType="password"
          autoComplete="password"
          returnKeyType="go"
          onSubmitEditing={fazerLogin}
          style={styles.input}
          editable={!loading}
        />

        <TouchableOpacity onPress={fazerLogin} disabled={loading} style={styles.botao}>
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.textoBotao}>Fazer Login</Text>}
        </TouchableOpacity>

        <View style={styles.sistema}>
          <Text style={styles.inicio}>Um sistema:</Text>
          <Image
            source={require("../assets/images/apk/APK_LOGO__5.png")}
            style={{ width: 130, height: 130 }}
            resizeMode="contain"
          />
        </View>

        <Pressable onPress={testarConexao} hitSlop={10}>
          <Text style={styles.servidor}>Servidor: {API_URL ? API_URL.replace(/^https?:\/\//, "") : "não configurado"}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: BRAND_RED },
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: BRAND_RED,
    padding: 20,
    gap: 15,
  },
  inicio: { fontFamily: "ManropeBold", color: "#FFFFFF", fontSize: 16 },
  mensagem: { color: "#FFFFFF", fontSize: 16, textAlign: "center", fontFamily: "Manrope", marginBottom: 5 },
  icone: { width: "60%", height: 80, tintColor: "white", marginBottom: 50 },
  input: { width: "100%", backgroundColor: "#fff", padding: 12, borderRadius: 8, fontFamily: "Manrope" },
  botao: { width: "100%", backgroundColor: "#000", padding: 14, borderRadius: 8, alignItems: "center" },
  textoBotao: { color: "#fff", fontWeight: "bold" },
  link: { color: "#FFFFFF", textDecorationLine: "underline", fontFamily: "Manrope" },
  sistema: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, marginTop: 40 },
  erroContainer: { backgroundColor: "#fff", padding: 10, borderRadius: 6, width: "100%" },
  erroTexto: { color: "red", textAlign: "center" },
  erroGoogle: { color: "#FFFFFF", marginTop: 10, textAlign: "center" },
  servidor: { color: "rgba(255,255,255,0.7)", fontSize: 11, fontFamily: "Manrope" },
});
