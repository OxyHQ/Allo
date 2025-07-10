import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  Image,
  Alert,
} from "react-native";
import React, { useEffect, useState } from "react";
import ScreenWrapper from "@/components/ScreenWrapper";
import Typo from "@/components/Typo";
import {
  getContacts,
  getConversations,
  newConversation,
} from "@/socket/socketEvents";
import Header from "@/components/Header";
import { colors, radius, spacingX, spacingY } from "@/constants/theme";
import BackButton from "@/components/BackButton";
import Avatar from "@/components/Avatar";
import { getAvatarPath, uploadFileToCloudinary } from "@/services/imageService";
import { useAuth } from "@/contexts/authContext";
import { useLocalSearchParams, useRouter } from "expo-router";
import Input from "@/components/Input";
import Button from "@/components/Button";
import * as ImagePicker from "expo-image-picker";

const NewConversationModal = () => {
  const [contacts, setContacts] = useState([]);
  const [groupName, setGroupName] = useState("");
  const [selectedParticipants, setSelectedParticipants] = useState<string[]>(
    []
  );
  const [groupAvatar, setGroupAvatar] = useState<{ uri: string } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const { user: currentUser } = useAuth();
  const { isGroup } = useLocalSearchParams();
  const isGroupMode = isGroup === "1";

  const router = useRouter();

  useEffect(() => {
    getContacts(processGetContacts);
    getContacts(null);
    newConversation(handleNewConversation);

    return () => {
      getContacts(processGetContacts, true);
      newConversation(handleNewConversation, true);
    };
  }, []);

  const processGetContacts = (res: any) => {
    console.log("got contacts");
    if (res.success) {
      setContacts(res.data);
    }
  };

  const handleNewConversation = (res: any) => {
    setIsLoading(false);
    if (res.success) {
      // todo: Navigate to the new conversation
      // todo: register newConversationHandler in home screen to update conversation list

      // console.log("new conversation created: ", res.data);
      router.back();

      router.push({
        pathname: "/(main)/conversation",
        params: {
          id: res.data._id,
          name: res.data.name,
          avatar: res.data.avatar,
          type: res.data.type,
          participants: JSON.stringify(res.data.participants),
        },
      });
    } else {
      console.error("Error creating conversation:", res.msg);
      Alert.alert("Error", res.msg);
    }
  };

  const toggleParticipant = (contact: any) => {
    setSelectedParticipants((prev) => {
      if (prev.includes(contact.id)) {
        return prev.filter((id) => id !== contact.id);
      }
      return [...prev, contact.id];
    });
  };

  const pickImage = async () => {
    let result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      //   allowsEditing: true,
      aspect: [4, 3],
      quality: 0.5,
    });

    if (!result.canceled) {
      setGroupAvatar(result.assets[0]);
    }
  };

  const onSelectUser = (contact: any) => {
    if (!currentUser) {
      console.error("Please login to start a conversation");
      return;
    }

    if (isGroupMode) {
      toggleParticipant(contact);
    } else {
      newConversation({
        type: "direct",
        participants: [currentUser.id, contact.id],
      });
    }
  };

  const createGroup = async () => {
    if (!groupName.trim()) return;
    if (!currentUser || selectedParticipants.length < 2) return;

    setIsLoading(true);
    try {
      let avatar = null;
      if (groupAvatar) {
        const uploadResult = await uploadFileToCloudinary(
          groupAvatar,
          "group-avatars"
        );
        if (uploadResult.success) {
          avatar = uploadResult.data;
        }
      }

      newConversation({
        type: "group",
        participants: [currentUser.id, ...selectedParticipants],
        name: groupName,
        avatar: avatar,
      });
    } catch (error) {
      console.error("Error creating group:", error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <ScreenWrapper isModal={true}>
      <View style={styles.container}>
        <Header
          title={isGroupMode ? "New Group" : "Select User"}
          leftIcon={<BackButton color={colors.black} />}
        />

        {isGroupMode && (
          <View style={styles.groupInfoContainer}>
            <View style={styles.avatarContainer}>
              <TouchableOpacity onPress={pickImage}>
                <Avatar
                  size={100}
                  uri={groupAvatar?.uri || null}
                  isGroup={true}
                />
              </TouchableOpacity>
            </View>
            <View style={styles.groupNameContainer}>
              <Input
                placeholder="Group Name"
                value={groupName}
                onChangeText={setGroupName}
              />
            </View>
          </View>
        )}

        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.contactList}
        >
          {contacts.map((user: any, index) => {
            const isSelected = selectedParticipants.includes(user.id);
            return (
              <TouchableOpacity
                key={index}
                style={[
                  styles.contactRow,
                  isSelected && styles.selectedContact,
                ]}
                onPress={() => onSelectUser(user)}
              >
                <Avatar size={45} uri={user.avatar} />
                <Typo fontWeight={"500"}>{user.name}</Typo>
                {isGroupMode && (
                  <View style={styles.selectionIndicator}>
                    <View
                      style={[styles.checkbox, isSelected && styles.checked]}
                    />
                  </View>
                )}
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {isGroupMode && selectedParticipants.length >= 2 && (
          <View style={styles.createGroupButton}>
            <Button
              onPress={createGroup}
              disabled={!groupName.trim()}
              loading={isLoading}
            >
              <Typo fontWeight={"bold"} size={17}>
                Create Group
              </Typo>
            </Button>
          </View>
        )}
      </View>
    </ScreenWrapper>
  );
};

export default NewConversationModal;

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: "5%",
    flex: 1,
  },
  groupInfoContainer: {
    alignItems: "center",
    marginTop: spacingY._10,
  },
  avatarContainer: {
    marginBottom: spacingY._10,
  },
  groupNameContainer: {
    width: "100%",
  },
  contactRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacingX._10,
    paddingVertical: spacingY._5,
  },
  selectedContact: {
    backgroundColor: colors.neutral100,
    borderRadius: radius._15,
  },
  contactList: {
    gap: spacingY._12,
    marginTop: spacingY._10,
    paddingTop: spacingY._10,
    paddingBottom: spacingY._20,
  },
  selectionIndicator: {
    marginLeft: "auto",
    marginRight: spacingX._10,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: colors.primary,
  },
  checked: {
    backgroundColor: colors.primary,
  },
  createGroupButton: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    padding: spacingX._15,
    backgroundColor: colors.white,
    borderTopWidth: 1,
    borderTopColor: colors.neutral200,
  },
});
