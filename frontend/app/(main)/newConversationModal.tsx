import {
  ScrollView,
  StyleSheet,
  View,
  Image,
  Alert,
  StatusBar,
  TouchableOpacity,
} from "react-native";
import React, { useEffect, useState } from "react";
import ScreenWrapper from "@/components/ScreenWrapper";
import {
  getContacts,
  getConversations,
  newConversation,
} from "@/socket/socketEvents";
import { Appbar, FAB, Searchbar, List, IconButton, TextInput, Text } from "react-native-paper";
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
        <Appbar.Header
          style={styles.header}
          theme={{
            colors: {
              surface: colors.alloGreen,
              onSurface: colors.white,
              primary: colors.white,
            }
          }}
        >
          <Appbar.BackAction
            onPress={() => setStep(1)}
            color={colors.white}
          />
          <Appbar.Content
            title="New Group"
            titleStyle={styles.headerTitle}
          />
        </Appbar.Header>
      );
    }

    return (
      <Appbar.Header
        style={styles.header}
        theme={{
          colors: {
            surface: colors.alloGreen,
            onSurface: colors.white,
            primary: colors.white,
          }
        }}
      >
        <Appbar.Action
          icon="close"
          iconColor={colors.white}
          onPress={() => router.back()}
        />
        <Appbar.Content
          title={isGroupMode ? "Add Participants" : "New Chat"}
          titleStyle={styles.headerTitle}
        />
        {isGroupMode && selectedParticipants.length > 0 && (
          <Appbar.Action
            icon="arrow-right"
            iconColor={colors.white}
            onPress={proceedToGroupInfo}
          />
        )}
      </Appbar.Header>
    );
  };

  const renderSearchBar = () => (
    <View style={styles.searchContainer}>
      <Searchbar
        placeholder="Search contacts..."
        onChangeText={setSearchQuery}
        value={searchQuery}
        style={styles.searchBar}
        theme={{
          colors: {
            surface: colors.neutral100,
            onSurface: colors.black,
            onSurfaceVariant: colors.timestampText,
          }
        }}
      />
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
              <Text style={[styles.selectedName, { fontSize: 12 }]}>
                {contact.name.split(' ')[0]}
              </Text>
            </View>
          ))}
        </ScrollView>
        <View style={styles.participantCount}>
          <Text style={{ fontSize: 14, color: colors.timestampText }}>
            {selectedParticipants.length} participant{selectedParticipants.length !== 1 ? 's' : ''} selected
          </Text>
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
        <Text style={[styles.avatarHint, { fontSize: 14, color: colors.timestampText }]}>
          Tap to add group photo
        </Text>
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
        <Text style={[styles.characterCount, { fontSize: 12, color: colors.timestampText }]}>
          {groupName.length}/25
        </Text>
      </View>

      <View style={styles.participantsSection}>
        <Text style={[styles.sectionTitle, { fontSize: 16, fontWeight: "600" }]}>
          Participants: {selectedParticipants.length + 1}
        </Text>

        {/* Current user */}
        <View style={styles.participantRow}>
          <Avatar size={40} uri={currentUser?.avatar || null} />
          <View style={styles.participantInfo}>
            <Text style={{ fontSize: 16, fontWeight: "500" }}>
              {currentUser?.name} (You)
            </Text>
            <Text style={{ fontSize: 14, color: colors.timestampText }}>Admin</Text>
          </View>
        </View>

        {/* Selected participants */}
        {getSelectedContacts().map((contact: any, index) => (
          <View key={index} style={styles.participantRow}>
            <Avatar size={40} uri={contact.avatar} />
            <View style={styles.participantInfo}>
              <Text style={{ fontSize: 16, fontWeight: "500" }}>{contact.name}</Text>
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
          <Text style={[styles.emptyText, { color: colors.timestampText }]}>
            {searchQuery ? "No contacts found" : "No contacts available"}
          </Text>
        </View>
      ) : (
        filteredContacts.map((user: any, index) => {
          const isSelected = selectedParticipants.includes(user.id);

          const renderAvatar = () => (
            <Avatar size={50} uri={user.avatar} />
          );

          const renderRight = () => (
            isGroupMode ? (
              <View style={[styles.checkbox, isSelected && styles.checked]}>
                {isSelected && (
                  <Icons.Check color={colors.white} size={14} weight="bold" />
                )}
              </View>
            ) : null
          );

          return (
            <List.Item
              key={index}
              title={user.name}
              description="Last seen recently"
              left={renderAvatar}
              right={renderRight}
              onPress={() => onSelectUser(user)}
              style={styles.contactRow}
              titleStyle={styles.contactTitle}
              descriptionStyle={styles.contactDescription}
            />
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
        <FAB
          style={styles.createButton}
          icon="check"
          onPress={createGroup}
          disabled={!groupName.trim() || isLoading}
          loading={isLoading}
          theme={{
            colors: {
              primaryContainer: colors.alloGreen,
              onPrimaryContainer: colors.white,
            },
          }}
        />
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
    backgroundColor: colors.alloGreen,
    elevation: 0,
    shadowOpacity: 0,
  },
  headerTitle: {
    color: colors.white,
    fontSize: 18,
    fontWeight: "600",
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
  searchBar: {
    elevation: 0,
    shadowOpacity: 0,
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
    paddingHorizontal: spacingX._15,
  },
  contactTitle: {
    fontSize: 16,
    fontWeight: "500",
    color: colors.black,
  },
  contactDescription: {
    fontSize: 14,
    color: colors.timestampText,
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
  createButton: {
    position: "absolute",
    bottom: spacingY._30,
    right: spacingX._20,
  },
});
