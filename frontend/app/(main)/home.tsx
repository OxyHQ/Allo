import React from "react";
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useAuth } from "@/contexts/authContext";
import ScreenWrapper from "@/components/ScreenWrapper";
import Button from "@/components/Button";
import Typo from "@/components/Typo";
import { colors, radius, spacingX, spacingY } from "@/constants/theme";
import * as Icons from "phosphor-react-native";
import { useRouter } from "expo-router";
import Avatar from "@/components/Avatar";
import ConversationListItem from "@/components/ConversationListItem";
import Loading from "@/components/Loading";
import useConversations from "@/hooks/useConversations";

const Home = () => {
  const { user: currentUser, signOut } = useAuth();
  const router = useRouter();
  const [selectedTab, setSelectedTab] = React.useState(0);
  const {
    loading,
    directConversations,
    groupConversations,
  } = useConversations();

  const handleLogout = async () => {
    await signOut();
  };

  // Render helpers
  const renderConversations = (conversations: any[], isDirect: boolean) => {
    return conversations.map((item, index) => (
      <ConversationListItem
        item={item}
        key={item._id || index}
        router={router}
        showDivider={conversations.length !== index + 1}
      />
    ));
  };

  const renderEmptyState = () => {
    if (!loading && selectedTab === 0 && directConversations.length === 0) {
      return (
        <Typo style={{ textAlign: "center" }}>
          You don&apos;t have any messages
        </Typo>
      );
    }
    if (!loading && selectedTab === 1 && groupConversations.length === 0) {
      return (
        <Typo style={{ textAlign: "center" }}>
          You haven&apos;t joined any groups yet
        </Typo>
      );
    }
    return null;
  };

  return (
    <ScreenWrapper showPattern={true} bgOpacity={0.4}>
      <View style={styles.container}>
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Typo
              color={colors.neutral200}
              size={19}
              textProps={{ numberOfLines: 1 }}
            >
              {"Welcome back, "}
              <Typo size={20} color={colors.white} fontWeight={"800"}>
                {currentUser?.name}
              </Typo>{" "}🤙
            </Typo>
          </View>

          <TouchableOpacity
            style={styles.settingIcon}
            onPress={() => router.push("/(main)/profileModal")}
          >
            <Icons.GearSix color={colors.white} weight="fill" size={22} />
          </TouchableOpacity>
        </View>
        <View style={styles.content}>
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingVertical: spacingY._20 }}
          >
            <View style={styles.navBar}>
              <View style={styles.tabs}>
                <TouchableOpacity
                  onPress={() => setSelectedTab(0)}
                  style={[
                    styles.tabStyle,
                    selectedTab === 0 && styles.activeTabStyle,
                  ]}
                >
                  <Typo>Direct Messages</Typo>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => setSelectedTab(1)}
                  style={[
                    styles.tabStyle,
                    selectedTab === 1 && styles.activeTabStyle,
                  ]}
                >
                  <Typo>Groups</Typo>
                </TouchableOpacity>
              </View>
            </View>

            <View style={styles.conversationList}>
              {selectedTab === 0 && renderConversations(directConversations, true)}
              {selectedTab === 1 && renderConversations(groupConversations, false)}
            </View>

            {renderEmptyState()}
            {loading && <Loading />}
          </ScrollView>
        </View>
      </View>

      <Button
        style={styles.floatingButton}
        onPress={() =>
          router.push({
            pathname: "/(main)/newConversationModal",
            params: { isGroup: selectedTab },
          })
        }
      >
        <Icons.Plus color={colors.black} weight="bold" size={24} />
      </Button>
    </ScreenWrapper>
  );
};

export default Home;

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: spacingX._20,
    gap: spacingY._15,
    paddingTop: spacingY._15,
    paddingBottom: spacingY._20,
  },

  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  content: {
    flex: 1,
    backgroundColor: colors.white,
    borderTopLeftRadius: radius._50,
    borderTopRightRadius: radius._50,
    borderCurve: "continuous",
    overflow: "hidden",
    paddingHorizontal: spacingX._20,
  },
  navBar: {
    flexDirection: "row",
    gap: spacingX._15,
    alignItems: "center",
    paddingHorizontal: spacingX._10,
  },
  tabs: {
    flexDirection: "row",
    gap: spacingX._10,
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  tabStyle: {
    paddingVertical: spacingY._10,
    paddingHorizontal: spacingX._20,
    borderRadius: radius.full,
    backgroundColor: colors.neutral100,
  },
  activeTabStyle: {
    backgroundColor: colors.primaryLight,
  },
  conversationList: {
    paddingVertical: spacingY._20,
  },
  settingIcon: {
    padding: spacingY._10,
    backgroundColor: colors.neutral700,
    borderRadius: radius.full,
  },

  floatingButton: {
    minWidth: 44,
    minHeight: 44,
    borderRadius: 100,
    position: "absolute",
    bottom: "5%",
    right: "5%",
  },
});
