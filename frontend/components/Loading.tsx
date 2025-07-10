import React from "react";
import { ActivityIndicator } from "react-native-paper";
import { View } from "react-native";
import { colors } from "@/constants/theme";

interface LoadingProps {
  size?: "small" | "large";
  color?: string;
}

const Loading = ({
  size = "large",
  color = colors.primaryDark,
}: LoadingProps) => {
  return (
    <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
      <ActivityIndicator size={size} animating={true} color={color} />
    </View>
  );
};

export default Loading;
