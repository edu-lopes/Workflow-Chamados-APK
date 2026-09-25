import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { API_URL } from "@/src/api";
import { useSession } from "@/src/session";
import { BRAND_BLUE } from "@/src/ui";
import Constants from "expo-constants";

const HEX = /^#[0-9A-Fa-f]{6}$/;

export default function SettingsScreen() {
  const router = useRouter();
  const { user, darkMode, iconColor, toggleDarkMode, saveIconColor, signOut } = useSession();
  const styles = useMemo(() => makeStyles(darkMode), [darkMode]);

  const [cor, setCor] = useState(iconColor);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ msg: string; error: boolean } | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => setCor(iconColor), [iconColor]);

  const showToast = (msg: string, error = false) => {
    setToast({ msg, error });
    Animated.sequence([
      Animated.timing(opacity, { toValue: 1, duration: 300, useNativeDriver: true }),
      Animated.delay(2000),
      Animated.timing(opacity, { toValue: 0, duration: 300, useNativeDriver: true }),
    ]).start(() => setToast(null));
  };

  const salvarCor = async () => {
    if (!HEX.test(cor)) return showToast("Formato inválido. Use #RRGGBB", true);
    setSaving(true);
    try {
      await saveIconColor(cor);
      showToast("Cor salva com sucesso!");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Erro ao salvar a cor", true);
    } finally {
      setSaving(false);
    }
  };

  const alternarTema = async () => {
    try {
      await toggleDarkMode();
    } catch {
      showToast("Não foi possível salvar o tema", true);
    }
  };

  const sair = async () => {
    await signOut();
    router.replace("/login");
  };

  const fg = darkMode ? "#FFF" : "#000";

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.backButton} hitSlop={10}>
            <Ionicons name="arrow-back-outline" size={24} color={fg} />
          </Pressable>
          <Text style={styles.title}>Configurações</Text>
          <View style={{ width: 24 }} />
        </View>

        <View style={styles.section}>
          <Text style={styles.label}>Cor do seu ícone (leituras):</Text>
          <View style={styles.colorRow}>
            <TextInput
              style={styles.input}
              value={cor}
              onChangeText={setCor}
              placeholder="#255088"
              placeholderTextColor={darkMode ? "#AAA" : "#666"}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={7}
            />
            <View style={[styles.preview, { backgroundColor: HEX.test(cor) ? cor : "transparent" }]} />
          </View>
          <Pressable style={[styles.button, saving && { opacity: 0.6 }]} onPress={salvarCor} disabled={saving}>
            <Text style={styles.buttonText}>Salvar cor</Text>
          </Pressable>
        </View>

        <View style={[styles.section, styles.rowBetween]}>
          <Text style={styles.label}>Modo escuro</Text>
          <Switch value={darkMode} onValueChange={alternarTema} />
        </View>

        <View style={styles.section}>
          <Pressable style={styles.logoutButton} onPress={sair}>
            <Text style={styles.logoutText}>Sair da conta</Text>
          </Pressable>
        </View>

        <Text style={styles.info}>
          {user?.email}
          {"\n"}Servidor: {API_URL || "não configurado"}
          {"\n"}Versão {Constants.expoConfig?.version ?? "-"}
        </Text>
      </ScrollView>

      {toast && (
        <Animated.View style={[styles.toast, { backgroundColor: toast.error ? "#FF3B30" : "#4CAF50", opacity }]}>
          <Text style={styles.toastText}>{toast.msg}</Text>
        </Animated.View>
      )}
    </SafeAreaView>
  );
}

function makeStyles(dark: boolean) {
  const fg = dark ? "#FFF" : "#000";
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: dark ? "#121212" : "#F5F5F5" },
    content: { padding: 20 },
    header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 20 },
    backButton: { padding: 5 },
    title: { fontSize: 20, fontFamily: "ManropeBold", color: fg },
    section: { marginBottom: 30 },
    rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    label: { fontSize: 16, fontFamily: "Manrope", marginBottom: 8, color: fg },
    colorRow: { flexDirection: "row", alignItems: "center", gap: 10 },
    input: {
      flex: 1,
      borderWidth: 1,
      borderColor: dark ? "#555" : "#CCC",
      padding: 10,
      borderRadius: 8,
      backgroundColor: dark ? "#333" : "#FFF",
      color: fg,
    },
    preview: { width: 50, height: 50, borderRadius: 25, borderWidth: 1, borderColor: "#CCC" },
    button: { marginTop: 10, backgroundColor: BRAND_BLUE, padding: 12, borderRadius: 8, alignItems: "center" },
    buttonText: { color: "#FFF", fontFamily: "ManropeBold" },
    logoutButton: { marginTop: 20, backgroundColor: "#FF3B30", padding: 14, borderRadius: 8, alignItems: "center" },
    logoutText: { color: "#FFF", fontFamily: "ManropeBold", fontSize: 16 },
    info: { fontSize: 11, fontFamily: "Manrope", color: dark ? "#777" : "#999", textAlign: "center", lineHeight: 17 },
    toast: {
      position: "absolute",
      bottom: 30,
      left: 20,
      right: 20,
      paddingVertical: 12,
      paddingHorizontal: 20,
      borderRadius: 8,
      alignItems: "center",
      justifyContent: "center",
      zIndex: 1000,
    },
    toastText: { color: "#FFF", fontFamily: "ManropeBold", fontSize: 14 },
  });
}
