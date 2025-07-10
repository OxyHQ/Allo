import {
  Image,
  ImageBackground,
  StyleSheet,
  TouchableOpacity,
  View,
  SafeAreaView,
} from "react-native";
import React from "react";
import { Text } from "react-native-paper";
import ScreenWrapper from "@/components/ScreenWrapper";
import { colors, spacingX, spacingY } from "@/constants/theme";
import Button from "@/components/Button";
import Animated, { FadeIn, FadeInDown } from "react-native-reanimated";
import { useRouter } from "expo-router";

const Welcome = () => {
  const router = useRouter();
  return (
    <ScreenWrapper showPattern={true} bgOpacity={0.2} color={colors.black}>
      <SafeAreaView style={{ flex: 1 }}>
        <View style={styles.container}>
          <View style={{ alignItems: "center" }}>
            <Text
              variant="headlineLarge"
              style={{ color: colors.white, fontWeight: '900', fontFamily: 'Phudu-Bold' }}
            >
              Allo by Oxy
            </Text>
          </View>

          <Animated.Image
            entering={FadeIn.duration(700).springify()}
            source={require("../../assets/images/welcome.png")}
            style={styles.welcomeImage}
            resizeMode="contain"
          />

          <View style={{ paddingVertical: spacingY._50, paddingHorizontal: spacingX._20, }}>
            <Text
              variant="headlineLarge"
              style={{ color: colors.white, fontWeight: '800', fontFamily: 'Phudu-Bold' }}
            >
              Stay Connected
            </Text>
            <Text
              variant="headlineLarge"
              style={{ color: colors.white, fontWeight: '800', fontFamily: 'Phudu-Bold' }}
            >
              with your friends
            </Text>
            <Text
              variant="headlineLarge"
              style={{ color: colors.white, fontWeight: '800', fontFamily: 'Phudu-Bold' }}
            >
              and family
            </Text>
          </View>

          <Button
            style={{ backgroundColor: colors.white }}
            onPress={() => router.push("/(auth)/register")}
          >
            <Text
              variant="titleLarge"
              style={{ fontWeight: 'bold', fontFamily: 'Phudu-Bold' }}
            >
              Get Started
            </Text>
          </Button>
        </View>
      </SafeAreaView>
    </ScreenWrapper>
  );
};

export default Welcome;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "space-around",
    paddingHorizontal: spacingX._20,
    marginVertical: spacingY._10,
  },
  background: {
    flex: 1,
    backgroundColor: colors.neutral900,
  },
  welcomeImage: {
    flex: 1,
    width: "100%",
    maxWidth: 900,
    maxHeight: 1000,
    height: undefined,
    alignSelf: "center",
    marginVertical: spacingY._10,
  },
});
