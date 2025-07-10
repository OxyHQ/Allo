import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  Image,
  Alert,
  TextInput,
  StatusBar,
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
import * as Icons from "phosphor-react-native";

const NewConversationModal = () => {
  const [contacts, setContacts] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [groupName, setGroupName] = useState("");
  const [selectedParticipants, setSelectedParticipants] = useState<string[]>([]);
  const [groupAvatar, setGroupAvatar] = useState<{ uri: string } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [step, setStep] = useState(1); // 1: select contacts, 2: group info
  const { user: currentUser } = useAuth();
  const { isGroup } = useLocalSearchParams();
  const isGroupMode = isGroup === "true";

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
      aspect: [1, 1],
      quality: 0.7,
      allowsEditing: true,
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
      setIsLoading(true);
      newConversation({
        type: "direct",
        participants: [currentUser.id, contact.id],
      });
    }
  };

  const proceedToGroupInfo = () => {
    if (selectedParticipants.length >= 1) {
      setStep(2);
    }
  };

  const createGroup = async () => {
    if (!groupName.trim()) return;
    if (!currentUser || selectedParticipants.length < 1) return;

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
      setIsLoading(false);
    }
  };

  // Filter contacts based on search query
  const filteredContacts = contacts.filter((contact: any) =>
    contact.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const getSelectedContacts = () => {
    return contacts.filter((contact: any) =>
      selectedParticipants.includes(contact.id)
    );
  };

  const renderHeader = () => {
    if (isGroupMode && step === 2) {
      return (
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.headerButton}
            onPress={() => setStep(1)}
          >
            <Icons.ArrowLeft color={colors.white} size={24} />
          </TouchableOpacity>
          <Typo color={colors.white} size={18} fontWeight="600" style={styles.headerTitle}>
            New Group
          </Typo>
          <View style={styles.headerButton} />
        </View>
      );
    }

    return (
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.headerButton}
          onPress={() => router.back()}
        >
          <Icons.X color={colors.white} size={24} />
        </TouchableOpacity>
        <Typo color={colors.white} size={18} fontWeight="600" style={styles.headerTitle}>
          {isGroupMode ? "Add Participants" : "New Chat"}
        </Typo>
        {isGroupMode && selectedParticipants.length > 0 && (
          <TouchableOpacity
            style={styles.headerButton}
            onPress={proceedToGroupInfo}
          >
            <Icons.ArrowRight color={colors.white} size={24} />
          </TouchableOpacity>
        )}
        {!isGroupMode && <View style={styles.headerButton} />}
      </View>
    );
  };

  const renderSearchBar = () => (
    <View style={styles.searchContainer}>
      <View style={styles.searchInputWrapper}>
        <Icons.MagnifyingGlass
          color={colors.timestampText}
          size={18}
          style={styles.searchIcon}
        />
        <TextInput
          style={styles.searchInput}
          placeholder="Search contacts..."
          placeholderTextColor={colors.timestampText}
          value={searchQuery}
          onChangeText={setSearchQuery}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity
            onPress={() => setSearchQuery("")}
            style={styles.clearButton}
          >
            <Icons.X color={colors.timestampText} size={16} />
          </TouchableOpacity>
        )}
      </View>
    </View>
  );

  const renderSelectedParticipants = () => {
    if (!isGroupMode || selectedParticipants.length === 0) return null;

    return (
      <View style={styles.selectedContainer}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.selectedScrollContent}
        >
          {getSelectedContacts().map((contact: any, index) => (
            <View key={index} style={styles.selectedParticipant}>
              <TouchableOpacity
                onPress={() => toggleParticipant(contact)}
                style={styles.selectedAvatarContainer}
              >
                <Avatar size={50} uri={contact.avatar} />
                <View style={styles.removeButton}>
                  <Icons.X color={colors.white} size={12} />
                </View>
              </TouchableOpacity>
              <Typo size={12} style={styles.selectedName}>
                {contact.name.split(' ')[0]}
              </Typo>
            </View>
          ))}
        </ScrollView>
        <View style={styles.participantCount}>
          <Typo size={14} color={colors.timestampText}>
            {selectedParticipants.length} participant{selectedParticipants.length !== 1 ? 's' : ''} selected
          </Typo>
        </View>
      </View>
    );
  };

  const renderGroupInfoStep = () => (
    <ScrollView style={styles.groupInfoContainer} showsVerticalScrollIndicator={false}>
      <View style={styles.groupAvatarSection}>
        <TouchableOpacity onPress={pickImage} style={styles.avatarTouchable}>
          <Avatar
            size={120}
            uri={groupAvatar?.uri || null}
            isGroup={true}
          />
          <View style={styles.cameraOverlay}>
            <Icons.Camera color={colors.white} size={24} />
          </View>
        </TouchableOpacity>
        <Typo size={14} color={colors.timestampText} style={styles.avatarHint}>
          Tap to add group photo
        </Typo>
      </View>

      <View style={styles.groupNameSection}>
        <View style={styles.groupNameInputWrapper}>
          <TextInput
            style={styles.groupNameInput}
            placeholder="Group name"
            placeholderTextColor={colors.timestampText}
            value={groupName}
            onChangeText={setGroupName}
            maxLength={25}
            autoFocus={true}
          />
          <View style={styles.groupNameUnderline} />
        </View>
        <Typo size={12} color={colors.timestampText} style={styles.characterCount}>
          {groupName.length}/25
        </Typo>
      </View>

      <View style={styles.participantsSection}>
        <Typo size={16} fontWeight="600" style={styles.sectionTitle}>
          Participants: {selectedParticipants.length + 1}
        </Typo>

        {/* Current user */}
        <View style={styles.participantRow}>
          <Avatar size={40} uri={currentUser?.avatar || null} />
          <View style={styles.participantInfo}>
            <Typo size={16} fontWeight="500">
              {currentUser?.name} (You)
            </Typo>
            <Typo size={14} color={colors.timestampText}>Admin</Typo>
          </View>
        </View>

        {/* Selected participants */}
        {getSelectedContacts().map((contact: any, index) => (
          <View key={index} style={styles.participantRow}>
            <Avatar size={40} uri={contact.avatar} />
            <View style={styles.participantInfo}>
              <Typo size={16} fontWeight="500">{contact.name}</Typo>
            </View>
            <TouchableOpacity
              onPress={() => toggleParticipant(contact)}
              style={styles.removeParticipantButton}
            >
              <Icons.X color={colors.timestampText} size={20} />
            </TouchableOpacity>
          </View>
        ))}
      </View>
    </ScrollView>
  );

  const renderContactsList = () => (
    <ScrollView
      showsVerticalScrollIndicator={false}
      contentContainerStyle={styles.contactList}
    >
      {filteredContacts.length === 0 ? (
        <View style={styles.emptyState}>
          <Typo color={colors.timestampText} style={styles.emptyText}>
            {searchQuery ? "No contacts found" : "No contacts available"}
          </Typo>
        </View>
      ) : (
        filteredContacts.map((user: any, index) => {
          const isSelected = selectedParticipants.includes(user.id);
          return (
            <TouchableOpacity
              key={index}
              style={styles.contactRow}
              onPress={() => onSelectUser(user)}
              activeOpacity={0.7}
            >
              <Avatar size={50} uri={user.avatar} />
              <View style={styles.contactInfo}>
                <Typo size={16} fontWeight="500" color={colors.black}>
                  {user.name}
                </Typo>
                <Typo size={14} color={colors.timestampText}>
                  Last seen recently
                </Typo>
              </View>
              {isGroupMode && (
                <View style={styles.selectionIndicator}>
                  <View style={[styles.checkbox, isSelected && styles.checked]}>
                    {isSelected && (
                      <Icons.Check color={colors.white} size={14} weight="bold" />
                    )}
                  </View>
                </View>
              )}
            </TouchableOpacity>
          );
        })
      )}
    </ScrollView>
  );

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor={colors.alloGreenDark} />

      {renderHeader()}

      <View style={styles.content}>
        {isGroupMode && step === 2 ? (
          renderGroupInfoStep()
        ) : (
          <>
            {renderSearchBar()}
            {renderSelectedParticipants()}
            {renderContactsList()}
          </>
        )}
      </View>

      {/* Create Group Button */}
      {isGroupMode && step === 2 && (
        <View style={styles.createButtonContainer}>
          <TouchableOpacity
            style={[
              styles.createButton,
              (!groupName.trim() || isLoading) && styles.createButtonDisabled
            ]}
            onPress={createGroup}
            disabled={!groupName.trim() || isLoading}
          >
            {isLoading ? (
              <Typo color={colors.white} fontWeight="600">Creating...</Typo>
            ) : (
              <Icons.Check color={colors.white} size={24} weight="bold" />
            )}
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
};

export default NewConversationModal;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.alloGreen,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacingX._15,
    paddingTop: spacingY._50,
    paddingBottom: spacingY._15,
    backgroundColor: colors.alloGreen,
  },
  headerButton: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    flex: 1,
    textAlign: "center",
  },
  content: {
    flex: 1,
    backgroundColor: colors.white,
  },
  searchContainer: {
    paddingHorizontal: spacingX._15,
    paddingTop: spacingY._15,
    paddingBottom: spacingY._10,
    backgroundColor: colors.white,
  },
  searchInputWrapper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.neutral100,
    borderRadius: radius._20,
    paddingHorizontal: spacingX._15,
    paddingVertical: spacingY._10,
  },
  searchIcon: {
    marginRight: spacingX._10,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
    color: colors.black,
    paddingVertical: spacingY._5,
  },
  clearButton: {
    padding: spacingY._5,
    marginLeft: spacingX._5,
  },
  selectedContainer: {
    backgroundColor: colors.neutral50,
    paddingVertical: spacingY._15,
  },
  selectedScrollContent: {
    paddingHorizontal: spacingX._15,
    gap: spacingX._15,
  },
  selectedParticipant: {
    alignItems: "center",
    width: 60,
  },
  selectedAvatarContainer: {
    position: "relative",
  },
  removeButton: {
    position: "absolute",
    top: -5,
    right: -5,
    backgroundColor: colors.timestampText,
    borderRadius: 10,
    width: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  selectedName: {
    marginTop: spacingY._5,
    textAlign: "center",
  },
  participantCount: {
    paddingHorizontal: spacingX._15,
    paddingTop: spacingY._10,
  },
  contactList: {
    paddingVertical: spacingY._10,
  },
  contactRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacingX._15,
    paddingVertical: spacingY._12,
  },
  contactInfo: {
    flex: 1,
    marginLeft: spacingX._12,
  },
  selectionIndicator: {
    marginLeft: spacingX._10,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: colors.alloGreen,
    alignItems: "center",
    justifyContent: "center",
  },
  checked: {
    backgroundColor: colors.alloGreen,
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacingY._40,
  },
  emptyText: {
    textAlign: "center",
  },
  groupInfoContainer: {
    flex: 1,
    paddingHorizontal: spacingX._20,
  },
  groupAvatarSection: {
    alignItems: "center",
    paddingVertical: spacingY._30,
  },
  avatarTouchable: {
    position: "relative",
  },
  cameraOverlay: {
    position: "absolute",
    bottom: 0,
    right: 0,
    backgroundColor: colors.alloGreen,
    borderRadius: 20,
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 3,
    borderColor: colors.white,
  },
  avatarHint: {
    marginTop: spacingY._10,
    textAlign: "center",
  },
  groupNameSection: {
    marginBottom: spacingY._30,
  },
  groupNameInputWrapper: {
    borderBottomWidth: 2,
    borderBottomColor: colors.alloGreen,
  },
  groupNameInput: {
    fontSize: 18,
    fontWeight: "500",
    color: colors.black,
    paddingVertical: spacingY._15,
    textAlign: "center",
  },
  groupNameUnderline: {
    height: 2,
    backgroundColor: colors.alloGreen,
  },
  characterCount: {
    textAlign: "right",
    marginTop: spacingY._5,
  },
  participantsSection: {
    flex: 1,
  },
  sectionTitle: {
    marginBottom: spacingY._15,
    color: colors.textDark,
  },
  participantRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacingY._10,
  },
  participantInfo: {
    flex: 1,
    marginLeft: spacingX._12,
  },
  removeParticipantButton: {
    padding: spacingY._5,
  },
  createButtonContainer: {
    position: "absolute",
    bottom: spacingY._30,
    right: spacingX._20,
  },
  createButton: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.alloGreen,
    alignItems: "center",
    justifyContent: "center",
    elevation: 8,
    shadowColor: colors.black,
    shadowOffset: {
      width: 0,
      height: 4,
    },
    shadowOpacity: 0.3,
    shadowRadius: 4.65,
  },
  createButtonDisabled: {
    backgroundColor: colors.timestampText,
  },
});
