import { StyleSheet, View } from "react-native";
import React from "react";
import { Stack } from "expo-router";
import { PaperProvider } from "react-native-paper";
import { AuthProvider } from "@/contexts/authContext";
import { CallHistoryProvider } from "@/contexts/callHistoryContext";
import { GlobalCallProvider } from "@/contexts/globalCallContext";
import { ThemeProvider, useTheme } from "@/contexts/themeContext";
import GlobalCallManager from "@/components/GlobalCallManager";
import { useFonts } from "expo-font";
import { getTheme } from "@/constants/paperTheme";

// Theme wrapper component to provide dynamic theme
function AppWithTheme({ children }: { children: React.ReactNode }) {
  const { isDarkMode } = useTheme();
  const theme = getTheme(isDarkMode);

  return (
    <PaperProvider theme={theme}>
      {children}
    </PaperProvider>
  );
}

function StackLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen
        name="(main)/profileModal"
        options={{ presentation: "modal" }}
      />
      <Stack.Screen
        name="(main)/newConversationModal"
        options={{ presentation: "modal" }}
      />
      <Stack.Screen
        name="(main)/settings"
        options={{ presentation: "card" }}
      />
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    "Phudu-Regular": require("../assets/fonts/Phudu/Phudu-Regular.ttf"),
    "Phudu-Bold": require("../assets/fonts/Phudu/Phudu-Bold.ttf"),
    "Phudu-Black": require("../assets/fonts/Phudu/Phudu-Black.ttf"),
    "Phudu-Light": require("../assets/fonts/Phudu/Phudu-Light.ttf"),
    "Phudu-Medium": require("../assets/fonts/Phudu/Phudu-Medium.ttf"),
    "Phudu-SemiBold": require("../assets/fonts/Phudu/Phudu-SemiBold.ttf"),
    "Phudu-ExtraBold": require("../assets/fonts/Phudu/Phudu-ExtraBold.ttf"),
  });

  if (!fontsLoaded) {
    return null; // or a loading spinner
  }

  return (
    <ThemeProvider>
      <AppWithTheme>
        <AuthProvider>
          <CallHistoryProvider>
            <GlobalCallProvider>
              <StackLayout />
              <GlobalCallManager />
            </GlobalCallProvider>
          </CallHistoryProvider>
        </AuthProvider>
      </AppWithTheme>
    </ThemeProvider>
  );
}
