import { colors } from "@/constants/theme";
import { ScreenWrapperProps } from "@/types";
import React from "react";
import {
  Dimensions,
  ImageBackground,
  Platform,
  StatusBar,
  StyleSheet,
  View,
  SafeAreaView,
} from "react-native";

const { height } = Dimensions.get("window");

const ScreenWrapper = ({
  style,
  children,
  showPattern = false,
  isModal = false,
  bgOpacity = 1,
  color = colors.neutral900,
}: ScreenWrapperProps) => {
  let paddingTop = Platform.OS == "ios" ? height * 0.06 : 40;
  let paddingBottom = 0;

  // if modal
  if (isModal) {
    paddingTop = Platform.OS == "ios" ? height * 0.02 : 45;
    paddingBottom = height * 0.02;
  }

  return (
    <ImageBackground
      style={{
        flex: 1,
        width: "100%",
        height: "100%",
        // if modal
        backgroundColor: isModal ? colors.white : color,
      }}
      imageStyle={{ opacity: showPattern ? bgOpacity : 0 }}
      source={require("../assets/images/bgPattern.png")}
      resizeMode="repeat"
    >
      <SafeAreaView style={{ flex: 1 }}>
        <View
          style={[
            {
              paddingTop,
              paddingBottom,
              flex: 1,
            },
            style,
          ]}
        >
          <StatusBar
            barStyle="light-content"
            backgroundColor={"transparent"}
          // animated={true}
          />
          {children}
        </View>
      </SafeAreaView>
    </ImageBackground>
  );
};

export default ScreenWrapper;

const styles = StyleSheet.create({});
