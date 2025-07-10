import {
  Alert,
  ImageBackground,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import React, { useRef, useState } from "react";
import { Text } from "react-native-paper";
import ScreenWrapper from "@/components/ScreenWrapper";
import { colors, radius, spacingX, spacingY } from "@/constants/theme";
import BackButton from "@/components/BackButton";
import Input from "@/components/Input";
import * as Icons from "phosphor-react-native";
import Button from "@/components/Button";
import { useRouter } from "expo-router";
import { useAuth } from "@/contexts/authContext";
const Login = () => {
  const emailRef = useRef("");
  const passwordRef = useRef("");
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();
  const { signIn } = useAuth();

  const handleSubmit = async () => {
    if (!emailRef.current || !passwordRef.current) {
      Alert.alert("Login", "Please fill all the fields");
      return;
    }
    try {
      setIsLoading(true);
      await signIn(emailRef.current, passwordRef.current);
      // After successful signup, navigation or further actions occur.
    } catch (error: any) {
      Alert.alert("Login Error", error.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS == "ios" ? "padding" : "height"}
    >
      <ScreenWrapper showPattern={true}>
        <View style={styles.container}>
          <View style={styles.header}>
            <BackButton iconSize={28} />
            <Text variant="bodyMedium" style={{ color: colors.white }}>
              Forgot your password?
            </Text>
          </View>
          <View style={styles.content}>
            <ScrollView
              contentContainerStyle={styles.form}
              showsVerticalScrollIndicator={false}
            >
              <View style={{ gap: spacingY._10, marginBottom: spacingY._15 }}>
                <Text variant="headlineMedium" style={{ fontWeight: '600' }}>
                  Welcome back
                </Text>
                <Text variant="bodyMedium" style={{ color: colors.neutral600 }}>We are happy to see you!</Text>
              </View>

              <Input
                placeholder="Enter your email"
                onChangeText={(value: string) => (emailRef.current = value)}
                icon={
                  <Icons.At
                    size={26}
                    color={colors.neutral600}
                  />
                }
              />
              <Input
                placeholder="Enter your password"
                secureTextEntry
                onChangeText={(value: string) => (passwordRef.current = value)}
                icon={
                  <Icons.Lock
                    size={26}
                    color={colors.neutral600}
                  />
                }
              />

              <View style={{ marginTop: spacingY._25, gap: spacingY._15 }}>
                <Button loading={isLoading} onPress={handleSubmit}>
                  <Text style={{ fontWeight: "bold", color: colors.black, fontSize: 20 }}>
                    Login
                  </Text>
                </Button>
                <View style={styles.footer}>
                  <Text>&apos;Don&apos;t have an account?&apos;</Text>
                  <Pressable onPress={() => router.push("/(auth)/register")}>
                    <Text style={{ fontWeight: "bold", color: colors.primaryDark }}>
                      Sign up
                    </Text>
                  </Pressable>
                </View>
              </View>
            </ScrollView>
          </View>
        </View>
      </ScreenWrapper>
    </KeyboardAvoidingView>
  );
};

export default Login;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    // gap: spacingY._30,
    // marginHorizontal: spacingX._20,
    justifyContent: "space-between",
  },
  header: {
    paddingHorizontal: spacingX._20,
    paddingTop: spacingY._15,
    paddingBottom: spacingY._25,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  content: {
    flex: 1,
    backgroundColor: colors.white,
    borderTopLeftRadius: radius._50,
    borderTopRightRadius: radius._50,
    borderCurve: "continuous",
    paddingHorizontal: spacingX._20,
    paddingTop: spacingY._20,
  },

  form: {
    gap: spacingY._15,
    marginTop: spacingY._20,
  },

  footer: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 5,
  },
});
