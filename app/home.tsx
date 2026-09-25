import { Ionicons } from "@expo/vector-icons";
import { useNetInfo } from "@react-native-community/netinfo";
import { Picker } from "@react-native-picker/picker";
import { useFocusEffect, useRouter } from "expo-router";
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  FlatList,
  Image,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { api, ApiError, type Ticket } from "@/src/api";
import { takePendingTicket } from "@/src/push";
import { useSession } from "@/src/session";
import { BRAND_RED, ReaderAvatars, shadow, StatusBadge, ticketStatus } from "@/src/ui";

type Filtro = "todos" | "abertos" | "encerrados" | "finalizados" | "cancelados";

function matchesFilter(t: Ticket, filtro: Filtro): boolean {
  switch (filtro) {
    case "abertos":
      return !t.encerrado && !t.finalizado && !t.cancelado;
    case "encerrados":
      return t.encerrado && !t.finalizado && !t.cancelado;
    case "finalizados":
      return t.finalizado && !t.cancelado;
    case "cancelados":
      return t.cancelado;
    default:
      return true;
  }
}

export default function HomeScreen() {
  const router = useRouter();
  const { user, darkMode, iconColor, signOut } = useSession();
  const netInfo = useNetInfo();
  const isOffline = netInfo.isConnected === false;
  const styles = useMemo(() => makeStyles(darkMode), [darkMode]);

  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [unread, setUnread] = useState<Set<string>>(new Set());
  const [filtro, setFiltro] = useState<Filtro>("todos");
  const [soNaoLidos, setSoNaoLidos] = useState(false);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [stale, setStale] = useState(false);

  const primeiroNome = user?.nome?.split(" ")[0] || "Usuário";

  /** Recarrega lista e não lidos (sem sincronizar com o Gmail). */
  const reload = useCallback(async () => {
    const [ticketsRes, unreadRes] = await Promise.allSettled([api.tickets(), api.unreadTicketIds()]);
    if (ticketsRes.status === "fulfilled") {
      setTickets(ticketsRes.value.data);
      setStale(ticketsRes.value.stale);
    } else if (!(ticketsRes.reason instanceof ApiError && ticketsRes.reason.status === 401)) {
      Alert.alert("Erro", ticketsRes.reason?.message ?? "Falha ao carregar tickets");
    }
    if (unreadRes.status === "fulfilled") setUnread(new Set(unreadRes.value.data));
    setLoading(false);
  }, []);

  // Ao focar a tela: atualiza dados e abre ticket vindo de notificação
  useFocusEffect(
    useCallback(() => {
      reload();
      takePendingTicket().then((id) => {
        if (id) router.push({ pathname: "/ticket/[id]", params: { id } });
      });
    }, [reload, router]),
  );

  const sincronizar = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const result = await api.sync();
      const novos = result.results.filter((r) => r.status === "processed").length;
      await reload();
      Alert.alert("Sincronização", novos > 0 ? `${novos} novo(s) e-mail(s) processado(s).` : "Nenhuma novidade!");
    } catch (err) {
      if (err instanceof ApiError && err.code === "GOOGLE_NOT_CONNECTED") {
        Alert.alert("Google desconectado", "Conecte a conta Google novamente para sincronizar.", [
          { text: "Agora não", style: "cancel" },
          { text: "Conectar", onPress: () => router.push({ pathname: "/login", params: { google: "reauth" } }) },
        ]);
      } else {
        Alert.alert("Erro", err instanceof Error ? err.message : "Não foi possível sincronizar os dados");
      }
    } finally {
      setSyncing(false);
    }
  }, [syncing, reload, router]);

  const sair = useCallback(() => {
    Alert.alert("Sair", "Deseja sair da conta?", [
      { text: "Cancelar", style: "cancel" },
      {
        text: "Sair",
        style: "destructive",
        onPress: async () => {
          await signOut();
          router.replace("/login");
        },
      },
    ]);
  }, [signOut, router]);

  // Animação do botão de atualizar
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!syncing) {
      spin.stopAnimation();
      spin.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(spin, { toValue: 1, duration: 1000, easing: Easing.linear, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [syncing, spin]);
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });

  const visiveis = useMemo(
    () => tickets.filter((t) => matchesFilter(t, filtro) && (!soNaoLidos || unread.has(t.ticket_externo_id))),
    [tickets, filtro, soNaoLidos, unread],
  );

  const abrirTicket = useCallback(
    (id: string) => router.push({ pathname: "/ticket/[id]", params: { id } }),
    [router],
  );

  const renderItem = useCallback(
    ({ item }: { item: Ticket }) => (
      <TicketCard
        ticket={item}
        unread={unread.has(item.ticket_externo_id)}
        styles={styles}
        darkMode={darkMode}
        userId={user?.id}
        iconColor={iconColor}
        onOpen={abrirTicket}
      />
    ),
    [unread, styles, darkMode, user?.id, iconColor, abrirTicket],
  );

  if (loading) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator size="large" color="#255088" />
        <Text style={styles.loadingText}>Carregando tickets...</Text>
      </View>
    );
  }

  const iconFg = darkMode ? "#FFF" : "#000";

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <View style={styles.navMenu}>
        <Pressable onPress={sair} hitSlop={10} accessibilityLabel="Sair">
          <Ionicons name="close-outline" size={24} color={iconFg} />
        </Pressable>
        <Text style={styles.title}>Workflow Datapar</Text>
        <Pressable onPress={() => router.push("/settings")} hitSlop={10} accessibilityLabel="Configurações">
          <Ionicons name="settings-outline" size={24} color={iconFg} />
        </Pressable>
      </View>

      <Text style={styles.welcome}>
        Olá <Text style={styles.nome}>{primeiroNome}</Text>, bem-vindo(a)!
      </Text>

      {(isOffline || stale) && (
        <View style={styles.offlineBanner}>
          <Text style={styles.offlineText}>📴 Modo offline – dados podem estar desatualizados</Text>
        </View>
      )}

      <View style={styles.filterRow}>
        <Text style={styles.chamados}>Chamados</Text>
        <Pressable style={styles.checkboxContainer} onPress={() => setSoNaoLidos((v) => !v)}>
          <View style={[styles.checkbox, soNaoLidos && styles.checkboxChecked]}>
            {soNaoLidos && <Text style={styles.checkmark}>✓</Text>}
          </View>
          <Text style={styles.checkboxLabel}>Não lidos</Text>
        </Pressable>
        <View style={styles.pickerContainer}>
          <Picker
            selectedValue={filtro}
            onValueChange={(v) => setFiltro(v as Filtro)}
            style={styles.picker}
            dropdownIconColor={iconFg}
          >
            <Picker.Item label="Todos" value="todos" />
            <Picker.Item label="Abertos" value="abertos" />
            <Picker.Item label="Encerrados" value="encerrados" />
            <Picker.Item label="Finalizados" value="finalizados" />
            <Picker.Item label="Cancelados" value="cancelados" />
          </Picker>
        </View>
      </View>

      <FlatList
        data={visiveis}
        keyExtractor={(t) => String(t.id)}
        renderItem={renderItem}
        style={styles.list}
        contentContainerStyle={styles.cards}
        showsVerticalScrollIndicator={false}
        initialNumToRender={8}
        windowSize={7}
        removeClippedSubviews
        refreshControl={<RefreshControl refreshing={syncing} onRefresh={sincronizar} />}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>Nenhum ticket encontrado</Text>
            <Image source={require("../assets/images/webicons/mailbox.png")} style={styles.imageMailBox} />
          </View>
        }
      />

      <Pressable
        style={[styles.refreshButton, syncing && styles.refreshButtonDisabled]}
        onPress={sincronizar}
        disabled={syncing}
        accessibilityLabel="Sincronizar"
      >
        <Animated.Image
          source={require("../assets/images/webicons/refresh.png")}
          style={[styles.refreshButtonImg, { transform: [{ rotate }] }]}
        />
      </Pressable>
    </SafeAreaView>
  );
}

type Styles = ReturnType<typeof makeStyles>;

const TicketCard = memo(function TicketCard({
  ticket,
  unread,
  styles,
  darkMode,
  userId,
  iconColor,
  onOpen,
}: {
  ticket: Ticket;
  unread: boolean;
  styles: Styles;
  darkMode: boolean;
  userId?: number;
  iconColor: string;
  onOpen: (id: string) => void;
}) {
  return (
    <Pressable style={styles.cardInfo} onPress={() => onOpen(ticket.ticket_externo_id)}>
      <View style={styles.topCardInfo}>
        <View style={styles.ticketContainer}>
          {unread && <View style={styles.unreadDot} />}
          <Text style={styles.ticket} numberOfLines={1}>
            Ticket: {ticket.ticket_externo_id}
          </Text>
        </View>
        <Text style={styles.data}>{ticket.data_criacao ?? "Data não disponível"}</Text>
      </View>

      <Text style={styles.descricao} numberOfLines={3}>
        {ticket.descricao}
      </Text>

      <View style={styles.readersSection}>
        <Text style={styles.readersLabel}>Lido por:</Text>
        {ticket.leitores?.length ? (
          <ReaderAvatars readers={ticket.leitores} currentUserId={userId} currentUserColor={iconColor} />
        ) : (
          <Text style={styles.noReaders}>Ninguém</Text>
        )}
      </View>

      <View style={styles.footerCard}>
        <StatusBadge status={ticketStatus(ticket)} />
        <Text style={styles.interacoes}>
          {ticket.total_interacoes} {ticket.total_interacoes === 1 ? "Interação" : "Interações"}
        </Text>
        <Ionicons
          name="chevron-down-outline"
          size={22}
          color={darkMode ? "#FFF" : "#E80000"}
          style={{ transform: [{ rotate: "-90deg" }] }}
        />
      </View>
    </Pressable>
  );
});

function makeStyles(dark: boolean) {
  const fg = dark ? "#FFF" : "#000";
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: dark ? "#121212" : "#F5F5F5", paddingHorizontal: 20 },
    centered: { justifyContent: "center", alignItems: "center" },
    loadingText: { marginTop: 10, fontFamily: "Manrope", color: dark ? "#CCC" : "#666" },
    emptyText: { textAlign: "center", fontFamily: "Manrope", color: dark ? "#BBB" : "#999", fontSize: 16 },
    imageMailBox: { marginTop: 20, width: 160, height: 240 },
    emptyContainer: { alignItems: "center", justifyContent: "center", marginTop: 50, width: "100%" },
    navMenu: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      width: "100%",
      marginBottom: 20,
      marginTop: 12,
    },
    nome: { fontFamily: "ManropeExtraBold", color: fg },
    title: { fontSize: 18, fontFamily: "ManropeMedium", color: fg },
    welcome: {
      fontSize: 18,
      fontFamily: "ManropeMedium",
      marginBottom: 20,
      marginTop: 10,
      alignSelf: "center",
      textAlign: "center",
      color: fg,
    },
    filterRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      width: "100%",
      marginBottom: 16,
    },
    chamados: { fontSize: 15, fontFamily: "Manrope", color: fg },
    checkboxContainer: { flexDirection: "row", alignItems: "center" },
    checkbox: {
      width: 20,
      height: 20,
      borderWidth: 2,
      borderColor: BRAND_RED,
      borderRadius: 4,
      marginRight: 8,
      justifyContent: "center",
      alignItems: "center",
    },
    checkboxChecked: { backgroundColor: BRAND_RED },
    checkmark: { color: "white", fontSize: 16, fontWeight: "bold", alignSelf: "center" },
    checkboxLabel: { fontFamily: "Manrope", fontSize: 14, color: fg },
    pickerContainer: {
      backgroundColor: dark ? "#333" : "#FFFFFF",
      borderRadius: 10,
      overflow: "hidden",
      ...shadow(6),
    },
    picker: {
      paddingHorizontal: 10,
      backgroundColor: dark ? "#333" : "#FFFFFF",
      minWidth: 130,
      fontFamily: "Manrope",
      color: fg,
    },
    list: { width: "100%", overflow: "visible" },
    cards: { gap: 14, paddingBottom: 90, paddingHorizontal: 4, paddingTop: 2 },
    cardInfo: {
      width: "100%",
      backgroundColor: dark ? "#1E1E1E" : "#FFFFFF",
      borderRadius: 10,
      padding: 14,
      gap: 10,
      ...shadow(4),
    },
    topCardInfo: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    ticketContainer: { flexDirection: "row", alignItems: "center", flex: 1, marginRight: 8 },
    unreadDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: BRAND_RED, marginRight: 6 },
    ticket: { fontSize: 16, fontFamily: "ManropeBold", flexShrink: 1, color: fg },
    data: { fontSize: 11, fontFamily: "ManropeLight", color: dark ? "#AAA" : "#555" },
    descricao: {
      textAlign: "left",
      fontSize: 10,
      color: dark ? "#CCC" : "#444",
      lineHeight: 15,
      fontFamily: "ManropeMedium",
    },
    readersSection: { flexDirection: "row", alignItems: "center", marginTop: 4, gap: 4 },
    readersLabel: { fontSize: 11, fontFamily: "Manrope", color: dark ? "#AAA" : "#666" },
    noReaders: { fontSize: 11, fontFamily: "Manrope", color: dark ? "#AAA" : "#999", fontStyle: "italic" },
    footerCard: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginTop: 4,
      gap: 6,
      flexWrap: "wrap",
    },
    interacoes: { fontSize: 12, color: dark ? "#AAA" : "#666", fontFamily: "Manrope", marginRight: 4 },
    offlineBanner: {
      backgroundColor: "#FFE0B2",
      padding: 8,
      borderRadius: 8,
      marginBottom: 10,
      width: "100%",
      alignItems: "center",
    },
    offlineText: { color: "#E65100", fontSize: 12 },
    refreshButton: {
      position: "absolute",
      bottom: 30,
      right: 20,
      width: 50,
      height: 50,
      borderRadius: 30,
      backgroundColor: "#ff0037",
      justifyContent: "center",
      alignItems: "center",
      zIndex: 1000,
      ...shadow(8),
    },
    refreshButtonImg: { width: 20, height: 20 },
    refreshButtonDisabled: { opacity: 0.5 },
  });
}
