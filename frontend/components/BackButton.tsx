import React from "react";
import { IconButton } from "react-native-paper";
import { useRouter } from "expo-router";
import { colors } from "@/constants/theme";
import { BackButtonProps } from "@/types";

const BackButton = ({
  style,
  iconSize = 26,
  color = colors.white,
}: BackButtonProps) => {
  const router = useRouter();
  return (
    <IconButton
      icon="arrow-left"
      size={iconSize}
      iconColor={color}
      onPress={() => router.back()}
      style={style}
    />
  );
};

export default BackButton;
