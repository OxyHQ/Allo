import { colors, spacingX, spacingY } from "@/constants/theme";
import { useAuth } from "@/contexts/authContext";
import { ConversationListItemProps } from "@/types";
import moment from "moment";
import React from "react";
import { StyleSheet, TouchableOpacity, View } from "react-native";
import Avatar from "./Avatar";
import Typo from "./Typo";
import * as Icons from "phosphor-react-native";

const ConversationListItem = ({
  item,
  showDivider,
  router,
}: ConversationListItemProps) => {
  const { user: currentUser } = useAuth();

  const openConversation = () => {
    router.push({
      pathname: "/(main)/conversation",
      params: {
        id: item._id,
        name: item.name,
        avatar: item.avatar,
        type: item.type,
        participants: JSON.stringify(item.participants),
      },
    });
  };

  let avatar = item.avatar;
  let isDirect = item.type == "direct";
  const otherParticipant = isDirect
    ? item.participants.find((p) => p._id !== currentUser?.id)
    : null;

  if (isDirect && otherParticipant) avatar = otherParticipant?.avatar;

  const lastMessage: any = item.lastMessage;

  const getLastMessageContent = () => {
    if (!lastMessage) return "No messages yet";
    return lastMessage.attachment ? "📷 Photo" : lastMessage.content;
  };

  const getLastMessageDate = () => {
    if (!lastMessage?.createdAt) return null;

    const messageDate = moment(lastMessage.createdAt);
    const today = moment();
    const yesterday = moment().subtract(1, 'day');

    if (messageDate.isSame(today, "day")) {
      return messageDate.format("h:mm A");
    }

    if (messageDate.isSame(yesterday, "day")) {
      return "Yesterday";
    }

    if (messageDate.isSame(today, "year")) {
      return messageDate.format("M/D/YY");
    }

    return messageDate.format("M/D/YY");
  };

  // Get unread count from conversation data
  const unreadCount = item.unreadCount || 0;

  return (
    <View>
      <TouchableOpacity
        style={styles.conversationItem}
        onPress={openConversation}
        activeOpacity={0.8}
      >
        <View style={styles.avatarContainer}>
          <Avatar uri={avatar} size={50} isGroup={item.type == "group"} />
        </View>

        <View style={styles.contentContainer}>
          <View style={styles.topRow}>
            <Typo size={16} fontWeight="400" style={styles.nameText} color={colors.black}>
              {isDirect ? otherParticipant?.name : item.name}
            </Typo>
            <View style={styles.timeContainer}>
              {lastMessage && (
                <Typo size={12} color={colors.timestampText} style={styles.timeText}>
                  {getLastMessageDate()}
                </Typo>
              )}
            </View>
          </View>

          <View style={styles.bottomRow}>
            <View style={styles.messagePreview}>
              {lastMessage && lastMessage.senderId === currentUser?.id && (
                <View style={styles.tickContainer}>
                  <Icons.Checks color={colors.timestampText} size={16} />
                </View>
              )}
              <Typo
                size={14}
                color={colors.timestampText}
                textProps={{ numberOfLines: 1 }}
                style={styles.messageText}
              >
                {getLastMessageContent()}
              </Typo>
            </View>

            <View style={styles.rightContainer}>
              {unreadCount > 0 && (
                <View style={styles.unreadBadge}>
                  <Typo size={12} color={colors.white} fontWeight="600">
                    {unreadCount > 99 ? "99+" : unreadCount}
                  </Typo>
                </View>
              )}
            </View>
          </View>
        </View>
      </TouchableOpacity>

      {showDivider && <View style={styles.divider} />}
    </View>
  );
};

export default ConversationListItem;

const styles = StyleSheet.create({
  conversationItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacingX._15,
    paddingVertical: spacingY._10,
    backgroundColor: colors.white,
  },
  avatarContainer: {
    marginRight: spacingX._12,
  },
  contentContainer: {
    flex: 1,
    justifyContent: "center",
  },
  topRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacingY._5,
  },
  nameText: {
    flex: 1,
    marginRight: spacingX._10,
  },
  timeContainer: {
    alignItems: "flex-end",
  },
  timeText: {
    textAlign: "right",
  },
  bottomRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  messagePreview: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
  },
  tickContainer: {
    marginRight: spacingX._5,
    justifyContent: "center",
    alignItems: "center",
  },
  messageText: {
    flex: 1,
  },
  rightContainer: {
    alignItems: "flex-end",
    justifyContent: "center",
    marginLeft: spacingX._10,
  },
  unreadBadge: {
    backgroundColor: colors.alloGreenLight,
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: spacingX._7,
  },
  divider: {
    height: 1,
    backgroundColor: "#E0E0E0",
    marginLeft: spacingX._15 + 50 + spacingX._12, // Avatar width + margins
    marginRight: spacingX._15,
  },
});
