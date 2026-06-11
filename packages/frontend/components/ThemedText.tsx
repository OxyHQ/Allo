import { StyleSheet, Text, type TextProps } from "react-native";
import { useTheme } from "@/hooks/useTheme";

export type ThemedTextProps = TextProps & {
  className?: string;
  type?: "default" | "title" | "defaultSemiBold" | "subtitle" | "link";
};

export function ThemedText({
  style,
  className,
  type = "default",
  ...rest
}: ThemedTextProps) {
  const theme = useTheme();

  return (
    <Text
      className={className}
      style={[
        { color: theme.colors.text },
        type === "default" ? styles.default : undefined,
        type === "title" ? styles.title : undefined,
        type === "defaultSemiBold" ? styles.defaultSemiBold : undefined,
        type === "subtitle" ? styles.subtitle : undefined,
        type === "link" ? { color: theme.colors.primary, lineHeight: 30, fontSize: 16 } : undefined,
        style,
      ]}
      {...rest}
    />
  );
}

const styles = StyleSheet.create({
  default: {
    fontSize: 16,
    lineHeight: 24,
  },
  defaultSemiBold: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '600',
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    lineHeight: 32,
  },
  subtitle: {
    fontSize: 20,
    fontWeight: "bold",
  },
});
