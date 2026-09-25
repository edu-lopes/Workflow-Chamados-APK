import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { api, cache, type Interacao, type TicketDetail } from "@/src/api";
import { dismissTicketNotifications } from "@/src/push";
import { useSession } from "@/src/session";
import { BRAND_BLUE, BRAND_RED, ReaderAvatars, shadow, StatusBadge, ticketStatus } from "@/src/ui";

export default function TicketScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user, darkMode, iconColor } = useSession();
  const styles = useMemo(() => makeStyles(darkMode), [darkMode]);

  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(true);
  const [marking, setMarking] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const res = await api.ticket(String(id));
      setTicket(res.data);
      setStale(res.stale);
    } catch (err) {
      Alert.alert("Erro", err instanceof Error ? err.message : "Não foi possível carregar o ticket");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  const voltar = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace("/home");
  }, [router]);

  const [primeira, ...demais] = ticket?.interacoes ?? [];
  const jaLeuUltima = useMemo(() => {
    const ultima = demais[demais.length - 1];
    return !!user && !!ultima?.leitores?.some((l) => l.id === user.id);
  }, [demais, user]);

  const marcarComoLido = async () => {
    if (!ticket) return;
    setMarking(true);
    try {
      await api.markTicketRead(ticket.ticketId);
      await Promise.all([
        dismissTicketNotifications(ticket.ticketId),
        cache.remove("unread"),
        cache.remove("tickets"),
      ]);
      voltar(); // a Home recarrega ao receber foco
    } catch (err) {
      Alert.alert("Erro", err instanceof Error ? err.message : "Não foi possível marcar como lido");
    } finally {
      setMarking(false);
    }
  };

  const fg = darkMode ? "#FFF" : "#000";

  if (loading) {
    return (
      <View style={[styles.container, styles.center]}>
        <ActivityIndicator size="large" color={BRAND_BLUE} />
      </View>
    );
  }

  if (!ticket) {
    return (
      <View style={[styles.container, styles.center]}>
        <Text style={styles.title}>Ticket não encontrado</Text>
        <Pressable onPress={voltar} hitSlop={10}>
          <Image
            style={{ width: 16, height: 16 }}
            source={require("../../assets/images/webicons/undo.png")}
            resizeMode="contain"
          />
        </Pressable>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <View style={styles.nav}>
        <Pressable onPress={voltar} hitSlop={10} accessibilityLabel="Voltar">
          <Ionicons name="arrow-back-outline" size={24} color={fg} />
        </Pressable>
        <Text style={styles.headerTitle}>Workflow Datapar</Text>
        <View style={{ width: 24 }} />
      </View>

      {stale && (
        <View style={styles.offlineBanner}>
          <Text style={styles.offlineText}>📴 Modo offline – dados podem estar desatualizados</Text>
        </View>
      )}

      <View style={styles.ticketHeader}>
        <Text style={styles.ticketTitle}>Ticket {ticket.ticketId}</Text>
        <View style={styles.dottedLine} />
      </View>
      <Text style={styles.date}>{primeira?.data || "Data não disponível"}</Text>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>{ticket.assunto.replace(/<[^>]+>/g, "").trim() || "Chamado"}</Text>
        <Text style={styles.description} numberOfLines={expanded ? undefined : 3}>
          {ticket.descricao}
        </Text>
        <Pressable onPress={() => setExpanded((v) => !v)} style={styles.expandButton} hitSlop={8}>
          <Ionicons
            name={expanded ? "chevron-up-outline" : "chevron-down-outline"}
            size={24}
            color={darkMode ? "#FFF" : "#666"}
          />
        </Pressable>

        <Text style={styles.interacoesTitle}>Interações ({demais.length}):</Text>

        <ScrollView
          style={styles.interacoesContainer}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 20 }}
        >
          {demais.map((interacao, index) => (
            <Mensagem
              key={index}
              interacao={interacao}
              anterior={index > 0 ? demais[index - 1] : null}
              styles={styles}
              userId={user?.id}
              iconColor={iconColor}
            />
          ))}
        </ScrollView>

        <StatusBadge status={ticketStatus(ticket)} style={styles.statusBadge} />
      </View>

      <Pressable
        style={[styles.button, (jaLeuUltima || marking) && styles.buttonDisabled]}
        onPress={marcarComoLido}
        disabled={jaLeuUltima || marking}
      >
        {marking ? (
          <ActivityIndicator color={fg} />
        ) : (
          <>
            <Text style={styles.buttonText}>Marcar como Lido</Text>
            <Ionicons name="checkmark-done-outline" size={22} color={fg} />
          </>
        )}
      </Pressable>
    </SafeAreaView>
  );
}

type Styles = ReturnType<typeof makeStyles>;

const Mensagem = React.memo(function Mensagem({
  interacao,
  anterior,
  styles,
  userId,
  iconColor,
}: {
  interacao: Interacao;
  anterior: Interacao | null;
  styles: Styles;
  userId?: number;
  iconColor: string;
}) {
  const isDatapar = interacao.lado === "datapar";
  const reaberto =
    anterior?.tipo === "pre_encerramento" && interacao.tipo === "interacao" && !!interacao.mensagem?.trim();

  return (
    <>
      {reaberto && (
        <View style={styles.reabertoContainer}>
          <Text style={styles.reabertoText}>Usuário reabriu o chamado</Text>
        </View>
      )}
      <View style={isDatapar ? styles.chatLeft : styles.chatRight}>
        {isDatapar ? (
          <Image
            style={{ width: 70, height: 30 }}
            source={require("../../assets/images/apk/datapar-logo.png")}
            resizeMode="contain"
          />
        ) : (
          <Image
            style={{ width: 50, height: 30, alignSelf: "flex-end" }}
            source={require("../../assets/images/apk/APK_LOGO__8.png")}
            resizeMode="contain"
          />
        )}
        <Text style={styles.msg}>{interacao.mensagem}</Text>
        <Text style={[styles.atendente, !isDatapar && styles.right]}>
          - {interacao.autor || (isDatapar ? "Atendente Datapar" : "Suporte APK")}
        </Text>
        <Text style={[styles.msgTime, !isDatapar && styles.right]}>{interacao.data}</Text>
        {interacao.leitores?.length > 0 && (
          <ReaderAvatars
            readers={interacao.leitores}
            currentUserId={userId}
            currentUserColor={iconColor}
            size={22}
            style={styles.readers}
          />
        )}
      </View>
    </>
  );
});

function makeStyles(dark: boolean) {
  const fg = dark ? "#FFF" : "#000";
  const bubble = {
    borderWidth: 1.5,
    borderRadius: 16,
    padding: 12,
    marginBottom: 15,
    maxWidth: "85%" as const,
    backgroundColor: dark ? "#2C2C2C" : "#FFF",
    ...shadow(2),
  };
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: dark ? "#121212" : "#F3F3F3", paddingHorizontal: 20, paddingBottom: 10 },
    center: { justifyContent: "center", alignItems: "center", gap: 7 },
    nav: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 20, marginTop: 12 },
    headerTitle: { fontFamily: "ManropeSemiBold", fontSize: 16, color: fg },
    title: { fontFamily: "ManropeMedium", fontSize: 18, color: fg },
    offlineBanner: { backgroundColor: "#FFE0B2", padding: 8, borderRadius: 8, marginBottom: 10, alignItems: "center" },
    offlineText: { color: "#E65100", fontSize: 12 },
    ticketHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
    ticketTitle: { fontSize: 20, fontFamily: "ManropeSemiBold", color: fg },
    dottedLine: { flex: 1, borderBottomWidth: 2, borderStyle: "dotted", borderColor: dark ? "#555" : "#707070" },
    date: { marginTop: 6, fontSize: 13, color: dark ? "#AAA" : "#666", marginBottom: 15 },
    card: { backgroundColor: dark ? "#1E1E1E" : "#FFF", borderRadius: 16, padding: 18, flex: 1, ...shadow(8) },
    sectionTitle: { fontFamily: "ManropeSemiBold", fontSize: 16, marginBottom: 8, color: fg },
    description: { fontSize: 13, lineHeight: 18, marginBottom: 5, color: dark ? "#CCC" : "#000" },
    expandButton: { alignSelf: "center", marginTop: 6, marginBottom: 15 },
    interacoesTitle: { fontFamily: "ManropeMedium", marginBottom: 10, color: fg },
    interacoesContainer: { flex: 1, marginBottom: 10 },
    reabertoContainer: { alignItems: "center", marginVertical: 10 },
    reabertoText: {
      backgroundColor: "#E3F2FD",
      color: BRAND_BLUE,
      paddingHorizontal: 12,
      paddingVertical: 4,
      borderRadius: 16,
      fontSize: 12,
      fontFamily: "ManropeMedium",
      overflow: "hidden",
    },
    chatLeft: { ...bubble, alignSelf: "flex-start", borderColor: BRAND_BLUE },
    chatRight: { ...bubble, alignSelf: "flex-end", borderColor: BRAND_RED },
    msg: { fontSize: 12, lineHeight: 17, fontFamily: "Manrope", color: fg },
    atendente: { fontSize: 11, marginTop: 6, opacity: 0.7, fontFamily: "Manrope", color: dark ? "#CCC" : "#000" },
    msgTime: { fontSize: 10, color: dark ? "#AAA" : "#666", marginTop: 4, fontFamily: "Manrope" },
    right: { textAlign: "right" },
    readers: { justifyContent: "flex-end", marginTop: 8, gap: 4 },
    statusBadge: { marginTop: 10, alignSelf: "flex-start" },
    button: {
      backgroundColor: dark ? "#333" : "#FFF",
      padding: 16,
      borderRadius: 14,
      flexDirection: "row",
      justifyContent: "center",
      alignItems: "center",
      gap: 10,
      marginTop: 15,
      ...shadow(6),
    },
    buttonText: { fontFamily: "ManropeSemiBold", color: fg },
    buttonDisabled: { opacity: 0.5, backgroundColor: dark ? "#555" : "#cecece", elevation: 0 },
  });
}
