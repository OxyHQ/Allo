import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import React from "react";
import { useRouter } from "expo-router";
import { CaretLeft } from "phosphor-react-native";
import { colors, radius } from "@/constants/theme";
import { BackButtonProps } from "@/types";

const BackButton = ({
  style,
  iconSize = 26,
  color = colors.white,
}: BackButtonProps) => {
  const router = useRouter();
  return (
    <TouchableOpacity
      onPress={() => router.back()}
      style={[styles.button, style]}
    >
      <CaretLeft size={iconSize} color={color} weight="bold" />
    </TouchableOpacity>
  );
};

export default BackButton;

const styles = StyleSheet.create({
  button: {
    // backgroundColor: colors.neutral600,
    // alignSelf: "flex-start",
    // borderRadius: radius._12,
    // borderCurve: "continuous",
    // padding: 5,
  },
});
