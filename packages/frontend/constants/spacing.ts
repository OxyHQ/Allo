/**
 * Spacing Constants
 *
 * Standardized spacing values for consistent UI across the app.
 * Uses Tailwind's spacing scale (1 unit = 4px).
 *
 * Usage:
 * ```tsx
 * import { SPACING } from '@/constants/spacing';
 *
 * <View className={`px-${SPACING.screen.horizontal} py-${SPACING.screen.vertical}`}>
 * ```
 */

export const SPACING = {
  /**
   * Screen-level spacing (outer container padding)
   */
  screen: {
    horizontal: 4,  // 16px - Standard horizontal padding for screens
    vertical: 4,    // 16px - Standard vertical padding for screens
    top: 2,         // 8px - Top padding when header is present
    bottom: 10,     // 40px - Bottom padding for scroll views (safe area)
  },

  /**
   * Section spacing (vertical gaps between major sections)
   */
  section: {
    gap: 6,         // 24px - Gap between major sections
    titleMargin: 2, // 8px - Margin below section titles
  },

  /**
   * Card/Container spacing
   */
  card: {
    padding: 4,     // 16px - Internal padding for cards
    gap: 3,         // 12px - Gap between items inside cards
    radius: 16,     // 16px - Border radius for cards (use directly, not Tailwind unit)
  },

  /**
   * List item spacing
   */
  item: {
    paddingVertical: 3.5,    // 14px - Vertical padding for list items
    paddingHorizontal: 4,    // 16px - Horizontal padding for list items
    gap: 3,                  // 12px - Gap between items in a list
    iconMargin: 3,           // 12px - Margin for icons next to text
  },

  /**
   * Content spacing (text, buttons, etc.)
   */
  content: {
    gap: 2,         // 8px - Gap between related content
    gapSmall: 1.5,  // 6px - Small gap (e.g., between message bubbles)
    gapLarge: 4,    // 16px - Large gap between unrelated content
  },

  /**
   * Common border radius values (in pixels, not Tailwind units)
   */
  radius: {
    small: 8,       // Small radius (buttons, chips)
    medium: 12,     // Medium radius (inputs, cards)
    large: 16,      // Large radius (modals, major cards)
    xlarge: 20,     // Extra large radius (special containers)
  },
} as const;

/**
 * Tailwind class helpers for common spacing patterns
 * Use these for consistent spacing across the app
 */
export const SPACING_CLASSES = {
  /**
   * Standard screen container
   * Example: <ScrollView className={SPACING_CLASSES.screen}>
   */
  screen: `px-${SPACING.screen.horizontal} pt-${SPACING.screen.top} pb-${SPACING.screen.bottom}`,

  /**
   * Screen with only horizontal padding (when vertical is handled separately)
   * Example: <View className={SPACING_CLASSES.screenHorizontal}>
   */
  screenHorizontal: `px-${SPACING.screen.horizontal}`,

  /**
   * Section title (uppercase label above sections)
   * Example: <Text className={SPACING_CLASSES.sectionTitle}>
   */
  sectionTitle: `text-[13px] font-semibold uppercase tracking-wide mb-${SPACING.section.titleMargin} px-1`,

  /**
   * Section gap (margin between sections)
   * Example: <View className={SPACING_CLASSES.sectionGap}>
   */
  sectionGap: `mt-${SPACING.section.gap}`,

  /**
   * Card container
   * Example: <View className={SPACING_CLASSES.card}>
   */
  card: `rounded-2xl border px-${SPACING.card.padding} py-${SPACING.card.padding}`,

  /**
   * List item (standard pressable item in settings, etc.)
   * Example: <TouchableOpacity className={SPACING_CLASSES.listItem}>
   */
  listItem: `px-${SPACING.item.paddingHorizontal} py-${SPACING.item.paddingVertical}`,
} as const;
