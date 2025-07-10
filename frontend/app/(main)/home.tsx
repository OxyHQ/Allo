import React from "react";
import {
  Alert,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  View,
  StatusBar,
  TextInput,
} from "react-native";
import { BottomNavigation, Appbar, FAB, Searchbar, Menu, Divider, Text, useTheme } from "react-native-paper";
import { useAuth } from "@/contexts/authContext";
import { useCallHistory } from "@/contexts/callHistoryContext";
import ScreenWrapper from "@/components/ScreenWrapper";
import Button from "@/components/Button";
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
  const theme = useTheme();
  const [selectedTab, setSelectedTab] = React.useState('chats');
  const [searchQuery, setSearchQuery] = React.useState("");
  const [menuVisible, setMenuVisible] = React.useState(false);
  const [isSelectionMode, setIsSelectionMode] = React.useState(false);
  const [selectedConversations, setSelectedConversations] = React.useState<Set<string>>(new Set());
  const {
    loading,
    directConversations,
    groupConversations,
  } = useConversations();

  const handleLogout = async () => {
    await signOut();
  };

  // Selection mode handlers
  const enterSelectionMode = (conversationId: string) => {
    setIsSelectionMode(true);
    setSelectedConversations(new Set([conversationId]));
  };

  const exitSelectionMode = () => {
    setIsSelectionMode(false);
    setSelectedConversations(new Set());
  };

  const toggleConversationSelection = (conversationId: string) => {
    setSelectedConversations(prev => {
      const newSet = new Set(prev);
      if (newSet.has(conversationId)) {
        newSet.delete(conversationId);
      } else {
        newSet.add(conversationId);
      }

      // Exit selection mode if no conversations selected
      if (newSet.size === 0) {
        setIsSelectionMode(false);
      }

      return newSet;
    });
  };

  const selectAllConversations = () => {
    const allConversations = [...directConversations, ...groupConversations];
    const filteredConversations = [
      ...filterConversations(directConversations),
      ...filterConversations(groupConversations)
    ];
    setSelectedConversations(new Set(filteredConversations.map(conv => conv._id)));
  };

  const handleBulkDelete = async () => {
    Alert.alert(
      "Delete Conversations",
      `Are you sure you want to delete ${selectedConversations.size} conversation(s)?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            // TODO: Implement bulk delete API call
            console.log("Deleting conversations:", Array.from(selectedConversations));
            exitSelectionMode();
          }
        }
      ]
    );
  };

  const handleBulkArchive = async () => {
    // TODO: Implement bulk archive API call
    console.log("Archiving conversations:", Array.from(selectedConversations));
    exitSelectionMode();
  };

  const handleBulkMarkAsRead = async () => {
    // TODO: Implement bulk mark as read API call
    console.log("Marking conversations as read:", Array.from(selectedConversations));
    exitSelectionMode();
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
        isSelectionMode={isSelectionMode}
        isSelected={selectedConversations.has(item._id)}
        onLongPress={() => enterSelectionMode(item._id)}
        onToggleSelection={() => toggleConversationSelection(item._id)}
      />
    ));
  };

  const renderEmptyState = () => {
    if (!loading && selectedTab === 'chats') {
      const filteredDirect = filterConversations(directConversations);
      const filteredGroup = filterConversations(groupConversations);

      if (searchQuery.trim()) {
        if (filteredDirect.length === 0 && filteredGroup.length === 0) {
          return (
            <View style={styles.emptyState}>
              <Text variant="bodyLarge" style={{ textAlign: "center", color: colors.textDark }}>
                No chats found
              </Text>
              <Text variant="bodyMedium" style={{ textAlign: "center", color: colors.timestampText }}>
                Try a different search term
              </Text>
            </View>
          );
        }
      } else if (directConversations.length === 0 && groupConversations.length === 0) {
        return (
          <View style={styles.emptyState}>
            <Text variant="bodyLarge" style={{ textAlign: "center", color: colors.textDark }}>
              No chats yet
            </Text>
            <Text variant="bodyMedium" style={{ textAlign: "center", color: colors.timestampText }}>
              Tap the new chat button to start messaging
            </Text>
          </View>
        );
      }
    }
    if (!loading && selectedTab === 'status') {
      return (
        <View style={styles.emptyState}>
          <Text variant="bodyLarge" style={{ textAlign: "center", color: colors.textDark }}>
            No status updates
          </Text>
        </View>
      );
    }
    if (!loading && selectedTab === 'calls' && callHistory.length === 0) {
      return (
        <View style={styles.emptyState}>
          <Text variant="bodyLarge" style={{ textAlign: "center", color: colors.textDark }}>
            No recent calls
          </Text>
        </View>
      );
    }
    return null;
  };



  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor={colors.alloGreenDark} />

      {/* Allo Header using react-native-paper Appbar */}
      <Appbar.Header
        style={styles.header}
        theme={{
          colors: {
            surface: colors.alloGreen,
            onSurface: colors.white,
            primary: colors.white,
          }
        }}
        mode="large"
      >
        <Appbar.Content
          title="Allo"
          titleStyle={styles.headerTitle}
        />
        <Menu
          visible={menuVisible}
          onDismiss={() => setMenuVisible(false)}
          anchor={
            <Appbar.Action
              icon="dots-vertical"
              iconColor={colors.white}
              onPress={() => setMenuVisible(true)}
            />
          }
          contentStyle={styles.menuContent}
        >
          <Menu.Item
            onPress={() => {
              setMenuVisible(false);
              router.push("/(main)/profileModal");
            }}
            title="Profile"
            leadingIcon="account-circle"
          />
          <Menu.Item
            onPress={() => {
              setMenuVisible(false);
              router.push("/(main)/settings");
            }}
            title="Settings"
            leadingIcon="cog"
          />
          <Divider />
          <Menu.Item
            onPress={() => {
              setMenuVisible(false);
              handleLogout();
            }}
            title="Logout"
            leadingIcon="logout"
            titleStyle={{ color: colors.rose }}
          />
        </Menu>
      </Appbar.Header>

      {/* Content Area */}
      <View style={[styles.content, { backgroundColor: theme.colors.background }]}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
        >
          {/* Chat List with Search */}
          {selectedTab === 'chats' && (
            <View style={styles.chatsContainer}>
              {/* Search Input */}
              {!isSelectionMode && (
                <View style={styles.searchContainer}>
                  <Searchbar
                    placeholder="Search conversations..."
                    onChangeText={setSearchQuery}
                    value={searchQuery}
                    style={styles.searchBar}
                    theme={theme}
                  />
                </View>
              )}

              {/* Selection Header */}
              {isSelectionMode && (
                <View style={styles.selectionHeader}>
                  <View style={styles.selectionHeaderLeft}>
                    <TouchableOpacity onPress={exitSelectionMode} style={styles.selectionBackButton}>
                      <Icons.X color={colors.black} size={24} />
                    </TouchableOpacity>
                    <Text variant="titleMedium" style={styles.selectionTitle}>
                      {selectedConversations.size} selected
                    </Text>
                  </View>
                  <View style={styles.selectionActions}>
                    <TouchableOpacity onPress={selectAllConversations} style={styles.selectionAction}>
                      <Icons.CheckSquare color={colors.alloGreen} size={24} />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={handleBulkMarkAsRead} style={styles.selectionAction}>
                      <Icons.CheckCircle color={colors.accentBlue} size={24} />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={handleBulkArchive} style={styles.selectionAction}>
                      <Icons.Archive color={colors.timestampText} size={24} />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={handleBulkDelete} style={styles.selectionAction}>
                      <Icons.Trash color={colors.rose} size={24} />
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              {/* Conversations List */}
              <View style={styles.conversationList}>
                {renderConversations(directConversations, true)}
                {renderConversations(groupConversations, false)}
              </View>
            </View>
          )}

          {/* Status Tab Content */}
          {selectedTab === 'status' && (
            <View style={styles.statusSection}>
              <View style={styles.myStatusItem}>
                <Avatar uri={currentUser?.avatar || null} size={50} />
                <View style={styles.statusTextContent}>
                  <Text variant="titleMedium" style={{ fontWeight: '600' }}>My status</Text>
                  <Text variant="bodyMedium" style={{ color: colors.timestampText }}>
                    Tap to add status update
                  </Text>
                </View>
                <TouchableOpacity>
                  <Icons.Camera color={colors.timestampText} size={24} />
                </TouchableOpacity>
              </View>

              {/* Recent updates section */}
              <View style={styles.statusHeader}>
                <Text variant="bodyMedium" style={{ color: colors.timestampText, fontWeight: '600' }}>
                  Recent updates
                </Text>
              </View>
            </View>
          )}

          {/* Calls Tab Content */}
          {selectedTab === 'calls' && (
            <View style={styles.callsSection}>
              <View style={styles.callsHeader}>
                <Text variant="bodyMedium" style={{ color: colors.timestampText, fontWeight: '600' }}>
                  Recent
                </Text>
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

      {/* Bottom Navigation using react-native-paper */}
      <BottomNavigation
        navigationState={{
          index: selectedTab === 'chats' ? 0 : selectedTab === 'status' ? 1 : selectedTab === 'camera' ? 2 : 3,
          routes: [
            { key: 'chats', title: 'Chats', focusedIcon: 'message', unfocusedIcon: 'message-outline' },
            { key: 'status', title: 'Status', focusedIcon: 'circle', unfocusedIcon: 'circle-outline' },
            { key: 'camera', title: 'Camera', focusedIcon: 'camera', unfocusedIcon: 'camera-outline' },
            { key: 'calls', title: 'Calls', focusedIcon: 'phone', unfocusedIcon: 'phone-outline' },
          ],
        }}
        onIndexChange={(index) => {
          const tabs = ['chats', 'status', 'camera', 'calls'];
          const newTab = tabs[index];
          if (newTab === 'camera') {
            router.push('/(main)/camera');
          } else {
            setSelectedTab(newTab);
          }
        }}
        renderScene={() => null}
        theme={{
          colors: {
            secondaryContainer: colors.alloGreen,
            onSecondaryContainer: colors.white,
            surface: colors.white,
            onSurface: colors.timestampText,
            primary: colors.alloGreen,
          },
        }}
        style={styles.bottomNavigation}
      />

      {/* Allo-style Floating Action Button using react-native-paper */}
      {selectedTab === 'chats' && (
        <FAB
          style={styles.fab}
          icon="message"
          onPress={() =>
            router.push({
              pathname: "/(main)/newConversationModal",
              params: { isGroup: "false" },
            })
          }
          theme={{
            colors: {
              primaryContainer: colors.alloGreenLight,
              onPrimaryContainer: colors.white,
            },
          }}
        />
      )}

      {selectedTab === 'status' && (
        <FAB
          style={styles.fab}
          icon="camera"
          onPress={() => {
            router.push('/(main)/camera');
          }}
          theme={{
            colors: {
              primaryContainer: colors.alloGreenLight,
              onPrimaryContainer: colors.white,
            },
          }}
        />
      )}

      {selectedTab === 'calls' && (
        <FAB
          style={styles.fab}
          icon="phone"
          onPress={() => {
            // Handle new call
            console.log('Starting new call');
          }}
          theme={{
            colors: {
              primaryContainer: colors.alloGreenLight,
              onPrimaryContainer: colors.white,
            },
          }}
        />
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
  },
  headerTitle: {
    color: colors.white,
    fontSize: 28,
    fontWeight: "500",
    fontFamily: "Phudu-Bold",
  },
  content: {
    flex: 1,
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
  searchBar: {
    elevation: 0,
    shadowOpacity: 0,
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
  bottomNavigation: {
    backgroundColor: colors.white,
    borderTopWidth: 1,
    borderTopColor: colors.neutral200,
  },
  fab: {
    position: "absolute",
    bottom: spacingY._25 + 80, // Adjusted to be above tab bar
    right: spacingX._20,
  },
  menuContent: {
    backgroundColor: colors.white,
    borderRadius: radius._10,
    marginTop: spacingY._10,
  },
  selectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: spacingX._15,
    paddingVertical: spacingY._12,
    backgroundColor: colors.neutral100,
    borderBottomWidth: 1,
    borderBottomColor: colors.neutral200,
  },
  selectionHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacingX._12,
  },
  selectionBackButton: {
    padding: spacingX._5,
  },
  selectionTitle: {
    color: colors.black,
    fontWeight: "600",
  },
  selectionActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacingX._15,
  },
  selectionAction: {
    padding: spacingX._7,
  },
});
