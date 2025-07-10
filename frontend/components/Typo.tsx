import { StyleSheet, TextStyle, View } from "react-native";
import React from "react";
import { Text } from "react-native-paper";
import { colors } from "@/constants/theme";
import { TypoProps } from "@/types";

const Typo = ({
  size = 16,
  color = colors.text,
  fontWeight = "400",
  children,
  style,
  textProps = {},
  fontFamily,
}: TypoProps & { fontFamily?: string }) => {
  const textStyle: TextStyle = {
    fontSize: size, // use size directly for fontSize
    color,
    fontWeight,
    fontFamily,
  };
  return (
    <Text style={[textStyle, style]} {...textProps}>
      {children}
    </Text>
  );
};

export default Typo;

const styles = StyleSheet.create({});
