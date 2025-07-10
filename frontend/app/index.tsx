import { Image, StatusBar, StyleSheet, Text, View } from "react-native";
import React, { useEffect } from "react";
import { colors } from "@/constants/theme";
import { useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Animated, {
  FadeIn,
  FadeInDown,
  FadeInUp,
} from "react-native-reanimated";

const index = () => {
  const router = useRouter();

  // useEffect(() => {
  //   checkAuth();
  // }, []);

  // const checkAuth = async () => {
  //   try {
  //     const token = await AsyncStorage.getItem("token");
  //     if (token) {
  //       setTimeout(() => {
  //         router.replace("/(main)/home");
  //       }, 1500);
  //     } else {
  //       setTimeout(() => {
  //         router.replace("/(auth)/welcome");
  //       }, 1500);
  //     }
  //   } catch (error) {
  //     console.error("Error loading token:", error);
  //     router.replace("/login");
  //   }
  // };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor={colors.neutral900} />
      <Animated.Image
        entering={FadeInDown.duration(700).springify()}
        style={styles.logo}
        resizeMode="contain"
        source={require("../assets/images/splashImage.png")}
      />
    </View>
  );
};

export default index;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.neutral900,
  },
  logo: {
    height: "23%",
    // aspectRatio: 1, // Remove this line for better responsiveness
    width: undefined, // Let the image scale naturally
  },
});
