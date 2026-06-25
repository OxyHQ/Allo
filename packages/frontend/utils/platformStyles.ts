import { Platform, type ViewStyle } from 'react-native';
import { colors } from '@/styles/colors';

export const shadowStyle = (opts?: { elevation?: number; web?: string }): ViewStyle => {
  const elev = opts?.elevation ?? 2;
  const web = opts?.web ?? `0px ${elev}px ${elev * 2}px ${colors.shadow}`;
  return Platform.select<ViewStyle>({
    // `boxShadow` is a web-only style handled by react-native-web at runtime.
    web: { boxShadow: web } as ViewStyle,
    default: {
      elevation: elev,
      shadowColor: colors.shadow,
      shadowOffset: { width: 0, height: Math.max(1, Math.round(elev / 2)) },
      shadowOpacity: 0.2,
      shadowRadius: Math.max(1, elev * 2),
    },
  }) ?? {};
};
