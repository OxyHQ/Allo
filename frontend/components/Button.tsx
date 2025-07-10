import React from "react";
import { Button as PaperButton } from "react-native-paper";
import { colors } from "@/constants/theme";
import { ButtonProps } from "@/types";

const Button = ({ style, onPress, loading = false, children }: ButtonProps) => {
  return (
    <PaperButton
      mode="contained"
      onPress={onPress}
      loading={loading}
      disabled={loading}
      style={style}
      buttonColor={colors.primary}
      textColor={colors.white}
      contentStyle={{ minHeight: 44 }}
    >
      {children}
    </PaperButton>
  );
};

export default Button;
