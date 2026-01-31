import { useMemo } from "react";
import { useTheme, type Theme, type ThemeColors } from "@/hooks/useTheme";
import { getColorTheme } from "@/styles/colorThemes";

/**
 * Hook to get conversation-specific theme
 * Falls back to global theme if no conversation theme is set
 *
 * @param conversationThemeId - Optional conversation-specific theme ID
 * @returns Theme object with conversation-specific or global theme
 */
export function useConversationTheme(conversationThemeId?: string | null): Theme {
  const globalTheme = useTheme();

  return useMemo(() => {
    // If no conversation theme, return global theme
    if (!conversationThemeId) {
      return globalTheme;
    }

    // Get conversation-specific color theme
    const conversationColorTheme = getColorTheme(conversationThemeId);
    const themeVariant = globalTheme.isDark
      ? conversationColorTheme.dark
      : conversationColorTheme.light;

    // Override global theme with conversation-specific colors
    const conversationColors: ThemeColors = {
      ...globalTheme.colors,

      // Override with conversation theme colors
      primary: conversationColorTheme.primaryColor,
      tint: conversationColorTheme.primaryColor,
      iconActive: conversationColorTheme.primaryColor,

      // Message bubble colors from conversation theme
      messageBubbleSent: themeVariant.bubbleSent,
      messageBubbleReceived: themeVariant.bubbleReceived,
      messageTextSent: themeVariant.textSent,
      messageTextReceived: themeVariant.textReceived,

      // Chat background from conversation theme
      chatBackground: themeVariant.chatBackground,
    };

    return {
      ...globalTheme,
      colors: conversationColors,
    };
  }, [conversationThemeId, globalTheme]);
}

/**
 * Helper to get conversation theme variant for preview/display
 */
export function getConversationThemeVariant(
  conversationThemeId: string | null | undefined,
  isDark: boolean
) {
  if (!conversationThemeId) return null;

  const colorTheme = getColorTheme(conversationThemeId);
  return isDark ? colorTheme.dark : colorTheme.light;
}
