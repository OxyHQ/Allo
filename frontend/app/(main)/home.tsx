import React from "react";
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  StatusBar,
  TextInput,
} from "react-native";
import { useAuth } from "@/contexts/authContext";
import { useCallHistory } from "@/contexts/callHistoryContext";
import ScreenWrapper from "@/components/ScreenWrapper";
import Button from "@/components/Button";
import Typo from "@/components/Typo";
import { colors, radius, spacingX, spacingY } from "@/constants/theme";
import * as Icons from "phosphor-react-native";
import { useRouter } from "expo-router";
import Avatar from "@/components/Avatar";
import ConversationListItem from "@/components/ConversationListItem";
import CallHistoryItem from "@/components/CallHistoryItem";
import Loading from "@/components/Loading";
import useConversations from "@/hooks/useConversations";

const Home = () => {
  const { user: currentUser, signOut } = useAuth();
  const { callHistory } = useCallHistory();
  const router = useRouter();
  const [selectedTab, setSelectedTab] = React.useState(0);
  const [searchQuery, setSearchQuery] = React.useState("");
  const {
    loading,
    directConversations,
    groupConversations,
  } = useConversations();

  const handleLogout = async () => {
    await signOut();
  };

  // Filter conversations based on search query
  const filterConversations = (conversations: any[]) => {
    if (!searchQuery.trim()) return conversations;

    return conversations.filter((item) => {
      const isDirect = item.type === "direct";
      const otherParticipant = isDirect
        ? item.participants.find((p: any) => p._id !== currentUser?.id)
        : null;

      const name = isDirect ? otherParticipant?.name : item.name;
      return name?.toLowerCase().includes(searchQuery.toLowerCase());
    });
  };

  // Render helpers
  const renderConversations = (conversations: any[], isDirect: boolean) => {
    const filteredConversations = filterConversations(conversations);
    return filteredConversations.map((item, index) => (
      <ConversationListItem
        item={item}
        key={item._id || index}
        router={router}
        showDivider={filteredConversations.length !== index + 1}
      />
    ));
  };

  const renderEmptyState = () => {
    if (!loading && selectedTab === 0) {
      const filteredDirect = filterConversations(directConversations);
      const filteredGroup = filterConversations(groupConversations);

      if (searchQuery.trim()) {
        if (filteredDirect.length === 0 && filteredGroup.length === 0) {
          return (
            <View style={styles.emptyState}>
              <Typo style={{ textAlign: "center", color: colors.textDark }}>
                No chats found
              </Typo>
              <Typo size={14} style={{ textAlign: "center" }} color={colors.timestampText}>
                Try a different search term
              </Typo>
            </View>
          );
        }
      } else if (directConversations.length === 0 && groupConversations.length === 0) {
        return (
          <View style={styles.emptyState}>
            <Typo style={{ textAlign: "center", color: colors.textDark }}>
              No chats yet
            </Typo>
            <Typo size={14} style={{ textAlign: "center" }} color={colors.timestampText}>
              Tap the new chat button to start messaging
            </Typo>
          </View>
        );
      }
    }
    if (!loading && selectedTab === 1) {
      return (
        <View style={styles.emptyState}>
          <Typo style={{ textAlign: "center", color: colors.textDark }}>
            No status updates
          </Typo>
        </View>
      );
    }
    if (!loading && selectedTab === 2 && callHistory.length === 0) {
      return (
        <View style={styles.emptyState}>
          <Typo style={{ textAlign: "center", color: colors.textDark }}>
            No recent calls
          </Typo>
        </View>
      );
    }
    return null;
  };

  const tabs = [
    { label: "Chats", icon: "ChatCircle" },
    { label: "Status", icon: "Circle" },
    { label: "Calls", icon: "Phone" },
  ];

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor={colors.alloGreenDark} />

      {/* Allo Header */}
      <View style={styles.header}>
        <View style={styles.headerContent}>
          <Typo
            color={colors.white}
            size={20}
            fontWeight="600"
            style={styles.headerTitle}
          >
            Allo
          </Typo>

          <View style={styles.headerIcons}>
            <TouchableOpacity
              style={styles.headerIcon}
              onPress={() => router.push("/(main)/profileModal")}
            >
              <Icons.DotsThreeVertical color={colors.white} size={22} />
            </TouchableOpacity>
          </View>
        </View>
      </View>

      {/* Content Area */}
      <View style={styles.content}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
        >
          {/* Chat List with Search */}
          {selectedTab === 0 && (
            <View style={styles.chatsContainer}>
              {/* Search Input */}
              <View style={styles.searchContainer}>
                <View style={styles.searchInputWrapper}>
                  <Icons.MagnifyingGlass
                    color={colors.timestampText}
                    size={18}
                    style={styles.searchIcon}
                  />
                  <TextInput
                    style={styles.searchInput}
                    placeholder="Search conversations..."
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

              {/* Conversations List */}
              <View style={styles.conversationList}>
                {renderConversations(directConversations, true)}
                {renderConversations(groupConversations, false)}
              </View>
            </View>
          )}

          {/* Status Tab Content */}
          {selectedTab === 1 && (
            <View style={styles.statusSection}>
              <View style={styles.myStatusItem}>
                <Avatar uri={currentUser?.avatar || null} size={50} />
                <View style={styles.statusTextContent}>
                  <Typo size={16} fontWeight="600">My status</Typo>
                  <Typo size={14} color={colors.timestampText}>
                    Tap to add status update
                  </Typo>
                </View>
                <TouchableOpacity>
                  <Icons.Camera color={colors.timestampText} size={24} />
                </TouchableOpacity>
              </View>

              {/* Recent updates section */}
              <View style={styles.statusHeader}>
                <Typo size={14} color={colors.timestampText} fontWeight="600">
                  Recent updates
                </Typo>
              </View>
            </View>
          )}

          {/* Calls Tab Content */}
          {selectedTab === 2 && (
            <View style={styles.callsSection}>
              <View style={styles.callsHeader}>
                <Typo size={14} color={colors.timestampText} fontWeight="600">
                  Recent
                </Typo>
              </View>
              <View style={styles.callsList}>
                {callHistory.map((call, index) => (
                  <CallHistoryItem
                    key={call.id}
                    {...call}
                    onCallBack={(callType) => {
                      // Navigate to conversation and start call
                      router.push({
                        pathname: '/(main)/conversation',
                        params: {
                          id: call.conversationId,
                          name: call.conversationName,
                          avatar: call.conversationAvatar || '',
                          type: call.isDirect ? 'direct' : 'group',
                          participants: call.participants.join(','),
                          startCall: callType, // This could trigger a call automatically
                        },
                      });
                    }}
                  />
                ))}
              </View>
            </View>
          )}

          {renderEmptyState()}
          {loading && <Loading />}
        </ScrollView>
      </View>

      {/* Bottom Tab Bar */}
      <View style={styles.bottomTabBar}>
        {tabs.map((tab, index) => {
          const isActive = selectedTab === index;

          const renderIcon = () => {
            if (tab.icon === "ChatCircle") {
              return (
                <Icons.ChatCircle
                  color={isActive ? colors.alloGreen : colors.timestampText}
                  size={24}
                  weight={isActive ? "fill" : "regular"}
                />
              );
            } else if (tab.icon === "Circle") {
              return (
                <Icons.Circle
                  color={isActive ? colors.alloGreen : colors.timestampText}
                  size={24}
                  weight={isActive ? "fill" : "regular"}
                />
              );
            } else if (tab.icon === "Phone") {
              return (
                <Icons.Phone
                  color={isActive ? colors.alloGreen : colors.timestampText}
                  size={24}
                  weight={isActive ? "fill" : "regular"}
                />
              );
            }
            return null;
          };

          return (
            <TouchableOpacity
              key={index}
              style={styles.bottomTab}
              onPress={() => setSelectedTab(index)}
              activeOpacity={0.7}
            >
              {renderIcon()}
              <Typo
                size={12}
                color={isActive ? colors.alloGreen : colors.timestampText}
                fontWeight={isActive ? "600" : "400"}
                style={styles.bottomTabLabel}
              >
                {tab.label}
              </Typo>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Allo-style Floating Action Button */}
      {selectedTab === 0 && (
        <TouchableOpacity
          style={styles.floatingButton}
          onPress={() =>
            router.push({
              pathname: "/(main)/newConversationModal",
              params: { isGroup: "false" },
            })
          }
        >
          <Icons.ChatCircle color={colors.white} weight="fill" size={24} />
        </TouchableOpacity>
      )}

      {selectedTab === 1 && (
        <TouchableOpacity style={styles.floatingButton}>
          <Icons.Camera color={colors.white} weight="fill" size={24} />
        </TouchableOpacity>
      )}

      {selectedTab === 2 && (
        <TouchableOpacity style={styles.floatingButton}>
          <Icons.Phone color={colors.white} weight="fill" size={24} />
        </TouchableOpacity>
      )}
    </View>
  );
};

export default Home;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.alloGreenDark,
  },
  header: {
    backgroundColor: colors.alloGreen,
    paddingTop: spacingY._50,
    paddingBottom: spacingY._15,
  },
  headerContent: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: spacingX._20,
  },
  headerTitle: {
    flex: 1,
  },
  headerIcons: {
    flexDirection: "row",
    gap: spacingX._20,
  },
  headerIcon: {
    padding: spacingY._5,
  },
  content: {
    flex: 1,
    backgroundColor: colors.white,
  },
  scrollContent: {
    flexGrow: 1,
    paddingBottom: spacingY._20, // Add padding for tab bar
  },
  chatsContainer: {
    flex: 1,
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
  conversationList: {
    paddingVertical: spacingY._5,
  },
  emptyState: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: spacingX._40,
    gap: spacingY._10,
    marginTop: spacingY._60,
  },
  statusSection: {
    padding: spacingX._15,
  },
  myStatusItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacingY._15,
    gap: spacingX._15,
  },
  statusTextContent: {
    flex: 1,
  },
  statusHeader: {
    paddingVertical: spacingY._10,
    marginTop: spacingY._10,
  },
  callsSection: {
    padding: spacingX._15,
  },
  callsList: {
    marginTop: spacingY._10,
  },
  callsHeader: {
    paddingVertical: spacingY._10,
  },
  bottomTabBar: {
    flexDirection: "row",
    backgroundColor: colors.white,
    borderTopWidth: 1,
    borderTopColor: colors.neutral200,
    paddingVertical: spacingY._10,
    paddingHorizontal: spacingX._10,
    paddingBottom: spacingY._25, // Extra padding for safe area
  },
  bottomTab: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacingY._5,
  },
  bottomTabLabel: {
    marginTop: spacingY._5,
    textAlign: "center",
  },
  floatingButton: {
    position: "absolute",
    bottom: spacingY._25 + 60, // Adjusted to be above tab bar
    right: spacingX._20,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.alloGreenLight,
    justifyContent: "center",
    alignItems: "center",
    elevation: 8,
    shadowColor: colors.black,
    shadowOffset: {
      width: 0,
      height: 4,
    },
    shadowOpacity: 0.3,
    shadowRadius: 4.65,
  },
});
