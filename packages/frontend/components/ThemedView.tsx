import { View, type ViewProps } from "react-native";
import { useTheme } from "@/hooks/useTheme";

export type ThemedViewProps = ViewProps & {
  className?: string;
};

export function ThemedView({ style, className, ...otherProps }: ThemedViewProps) {
  const theme = useTheme();
  return (
    <View
      className={className}
      style={[{ backgroundColor: theme.colors.background }, style]}
      {...otherProps}
    />
  );
}
