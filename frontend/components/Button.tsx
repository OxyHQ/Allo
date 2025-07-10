import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import React from "react";
import { colors, radius, spacingX } from "@/constants/theme";
import Loading from "./Loading";
import { ButtonProps } from "@/types";

const Button = ({ style, onPress, loading = false, children }: ButtonProps) => {
  if (loading) {
    return (
      <View style={[styles.button, style, { backgroundColor: "transparent" }]}>
        <Loading />
      </View>
    );
  }
  return (
    <TouchableOpacity onPress={onPress} style={[styles.button, style]}>
      {children}
    </TouchableOpacity>
  );
};

export default Button;

const styles = StyleSheet.create({
  button: {
    backgroundColor: colors.primary,
    borderRadius: radius.full,
    borderCurve: "continuous",
    minHeight: 44, // minimum touch target
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: spacingX._20,
  },
});
