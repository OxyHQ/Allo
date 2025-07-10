import {
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  View,
} from "react-native";
import React, { useEffect, useState } from "react";
import { colors, spacingX, spacingY } from "@/constants/theme";
import ScreenWrapper from "@/components/ScreenWrapper";
import BackButton from "@/components/BackButton";
import { Image } from "expo-image";
import * as Icons from "phosphor-react-native";
import { Text } from "react-native-paper";
import Input from "@/components/Input";
import { UserDataProps } from "@/types";
import Button from "@/components/Button";
import { useAuth } from "@/contexts/authContext";
import { useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import Header from "@/components/Header";
import Avatar from "@/components/Avatar";
import { getAvatarPath, uploadFileToCloudinary } from "@/services/imageService";
import { updateProfile } from "@/socket/socketEvents";

const ProfileModal = () => {
  const { user, updateToken, signOut } = useAuth();
  const [userData, setUserData] = useState<UserDataProps>({
    name: "",
    email: "",
    avatar: null,
  });
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  useEffect(() => {
    updateProfile(processUpdateProfile);

    return () => {
      updateProfile(processUpdateProfile, true);
    };
  }, []);

  const processUpdateProfile = (res: any) => {
    setLoading(false);
    // console.log('got res: ', res);
    if (res.success) {
      updateToken(res?.data?.token);
      router.back();
    } else {
      Alert.alert("User", res.msg);
    }
  };

  useEffect(() => {
    setUserData({
      email: user?.email || "",
      name: user?.name || "",
      avatar: user?.avatar,
    });
  }, [user]);

  const onPickImage = async () => {
    let result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      //   allowsEditing: true,
      aspect: [4, 3],
      quality: 0.5,
    });

    if (!result.canceled) {
      setUserData({ ...userData, avatar: result.assets[0] });
    }
  };

  const onSubmit = async () => {
    let { name, avatar } = userData;
    // console.log("name, avatar: ", userData);
    if (!name.trim()) {
      Alert.alert("User", "Please enter your name!");
      return;
    }

    let data = {
      name,
      avatar,
    };

    if (avatar && avatar?.uri) {
      setLoading(true);
      const res = await uploadFileToCloudinary(avatar, "profiles");
      if (res.success) {
        data.avatar = res.data;
      } else {
        Alert.alert("User", res.msg);
        setLoading(false);
        return;
      }
    }

    updateProfile(data);
  };

  const handleLogout = async () => {
    router.back();
    await signOut();
  };

  const showLogoutAlert = () => {
    Alert.alert("Confirm", "Are you sure you want to logout?", [
      {
        text: "Cancel",
        onPress: () => console.log("cancel logout"),
        style: "cancel",
      },
      {
        text: "Logout",
        onPress: () => handleLogout(),
        style: "destructive",
      },
    ]);
  };

  return (
    <ScreenWrapper isModal={true}>
      <View style={styles.container}>
        <Header
          title="Update Profile"
          leftIcon={
            Platform.OS == "android" && <BackButton color={colors.black} />
          }
          style={{ marginVertical: spacingY._15 }}
        />

        {/* form */}
        <ScrollView contentContainerStyle={styles.form}>
          <View style={styles.avatarContainer}>
            <Avatar uri={userData.avatar} size={170} />

            <TouchableOpacity onPress={onPickImage} style={styles.editIcon}>
              <Icons.Pencil
                size={20}
                color={colors.neutral800}
              />
            </TouchableOpacity>
          </View>

          <View style={{ gap: spacingY._20 }}>
            <View style={styles.inputContainer}>
              <Text style={{ paddingLeft: spacingX._10 }}>Email</Text>
              <Input
                value={userData.email}
                containerStyle={{
                  borderColor: colors.neutral350,
                  paddingLeft: spacingX._20,
                  backgroundColor: colors.neutral300,
                }}
                onChangeText={(value) =>
                  setUserData({ ...userData, name: value })
                }
                editable={false}
              />
            </View>
            <View style={styles.inputContainer}>
              <Text style={{ paddingLeft: spacingX._10 }}>Name</Text>
              <Input
                value={userData.name}
                containerStyle={{
                  borderColor: colors.neutral350,
                  paddingLeft: spacingX._20,
                }}
                onChangeText={(value) =>
                  setUserData({ ...userData, name: value })
                }
              />
            </View>
          </View>
        </ScrollView>
      </View>

      <View style={styles.footer}>
        {!loading && (
          <Button
            style={{
              backgroundColor: colors.rose,
              height: 56,
              width: 56,
            }}
            onPress={showLogoutAlert}
          >
            <Icons.SignOut
              size={30}
              color={colors.white}
              weight="bold"
            />
          </Button>
        )}

        <Button onPress={onSubmit} loading={loading} style={{ flex: 1 }}>
          <Text style={{ color: colors.black, fontWeight: "700" }}>
            Update
          </Text>
        </Button>
      </View>
    </ScreenWrapper>
  );
};

export default ProfileModal;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "space-between",
    paddingHorizontal: spacingY._20,
    // paddingVertical: spacingY._30,
  },
  footer: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "center",
    paddingHorizontal: spacingX._20,
    gap: 12,
    paddingTop: spacingY._15,
    borderTopColor: colors.neutral200,
    marginBottom: spacingY._10,
    borderTopWidth: 1,
  },
  form: {
    gap: spacingY._30,
    marginTop: spacingY._15,
  },
  avatarContainer: {
    position: "relative",
    alignSelf: "center",
  },
  avatar: {
    alignSelf: "center",
    backgroundColor: colors.neutral300,
    maxWidth: "60%",
    aspectRatio: 1,
    borderRadius: 200,
    borderWidth: 1,
    borderColor: colors.neutral500,
    // overflow: "hidden",
    // position: "relative",
  },
  editIcon: {
    position: "absolute",
    bottom: spacingY._5,
    right: spacingY._7,
    borderRadius: 100,
    backgroundColor: colors.neutral100,
    shadowColor: colors.black,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.25,
    shadowRadius: 10,
    elevation: 4,
    padding: spacingY._7,
  },
  inputContainer: {
    gap: spacingY._7,
  },
});
