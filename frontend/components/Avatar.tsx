import { StyleSheet, Text, View } from "react-native";
import React from "react";
import { Image } from "expo-image";
import { colors, radius } from "@/constants/theme";
import { AvatarProps } from "@/types";
import { getAvatarPath } from "@/services/imageService";

const Avatar = ({ uri, size = 40, style, isGroup = false }: AvatarProps) => {
  return (
    <View
      style={[
        styles.avatar,
        { height: size, width: size }, // let parent pass size, but default is 40
        style,
      ]}
    >
      <Image
        style={{ flex: 1 }}
        source={getAvatarPath(uri, isGroup)}
        contentFit="cover"
        transition={100}
      />
    </View>
  );
};

export default Avatar;

const styles = StyleSheet.create({
  avatar: {
    alignSelf: "center",
    backgroundColor: colors.neutral200,
    // height/width removed for responsiveness
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.neutral100,
    overflow: "hidden",
  },
});
