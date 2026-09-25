/**
 * Peças visuais compartilhadas entre Home e Ticket (antes duplicadas).
 */
import React, { memo } from "react";
import { Platform, StyleSheet, Text, View, type TextStyle, type ViewStyle } from "react-native";
import type { Reader } from "./api";
import { DEFAULT_ICON_COLOR } from "./session";

export const BRAND_RED = "#e50d3b";
export const BRAND_BLUE = "#255088";

// Usuários que exibem duas letras no avatar (comportamento mantido do app original)
const TWO_LETTER_INITIAL_USER_IDS = new Set([3, 5]);

export function shadow(level: number): ViewStyle {
  return Platform.select<ViewStyle>({
    ios: {
      shadowColor: "#000",
      shadowOffset: { width: 0, height: Math.max(2, level / 2) },
      shadowOpacity: 0.1,
      shadowRadius: level,
    },
    android: { elevation: level },
    web: { boxShadow: `0px ${Math.max(2, level / 2)}px ${level * 2}px rgba(0,0,0,0.1)` } as ViewStyle,
  }) as ViewStyle;
}

/* ---------------- Status do ticket ---------------- */

type StatusKey = "aberto" | "encerrado" | "finalizado" | "cancelado";

export function ticketStatus(t: { cancelado: boolean; finalizado: boolean; encerrado: boolean }): StatusKey {
  if (t.cancelado) return "cancelado";
  if (t.finalizado) return "finalizado";
  if (t.encerrado) return "encerrado";
  return "aberto";
}

const STATUS: Record<StatusKey, { label: string; style: TextStyle }> = {
  aberto: { label: "Aberto", style: { backgroundColor: "#E3F2FD", color: BRAND_BLUE } },
  encerrado: { label: "Pré-encerrado", style: { backgroundColor: "#FFE0B2", color: "#E65100" } },
  finalizado: { label: "Finalizado", style: { backgroundColor: "#D3D3D3", color: "#333" } },
  cancelado: { label: "Cancelado", style: { backgroundColor: "#F44336", color: "#FFF" } },
};

export const StatusBadge = memo(function StatusBadge({
  status,
  style,
}: {
  status: StatusKey;
  style?: TextStyle;
}) {
  return <Text style={[styles.badge, STATUS[status].style, style]}>{STATUS[status].label}</Text>;
});

/* ---------------- Avatares de quem leu ---------------- */

function initialsOf(reader: Reader): string {
  const nome = reader.nome ?? "";
  if (TWO_LETTER_INITIAL_USER_IDS.has(reader.id) && nome.length >= 2) {
    return nome.charAt(0).toUpperCase() + nome.charAt(1).toLowerCase();
  }
  return reader.inicial ?? nome.charAt(0).toUpperCase();
}

export const ReaderAvatars = memo(function ReaderAvatars({
  readers,
  currentUserId,
  currentUserColor,
  size = 19,
  style,
}: {
  readers: Reader[];
  currentUserId?: number;
  currentUserColor?: string;
  size?: number;
  style?: ViewStyle;
}) {
  return (
    <View style={[styles.avatars, style]}>
      {readers.map((r) => {
        const backgroundColor =
          currentUserId === r.id && currentUserColor ? currentUserColor : r.icon_color || DEFAULT_ICON_COLOR;
        return (
          <View
            key={r.id}
            style={[styles.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor }]}
          >
            <Text style={[styles.avatarText, { fontSize: Math.round(size * 0.47) }]}>{initialsOf(r)}</Text>
          </View>
        );
      })}
    </View>
  );
});

const styles = StyleSheet.create({
  badge: {
    fontFamily: "ManropeMedium",
    fontSize: 13,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    overflow: "hidden",
  },
  avatars: { flexDirection: "row", alignItems: "center", gap: 2 },
  avatar: { justifyContent: "center", alignItems: "center" },
  avatarText: { color: "#FFF", fontFamily: "ManropeBold" },
});
