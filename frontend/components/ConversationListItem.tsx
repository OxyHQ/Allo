import { colors, spacingX, spacingY } from "@/constants/theme";
import { useAuth } from "@/contexts/authContext";
import { ConversationListItemProps } from "@/types";
import moment from "moment";
import React from "react";
import { StyleSheet, View, TouchableOpacity } from "react-native";
import { List, Badge, Text, Checkbox, useTheme } from "react-native-paper";
import Avatar from "./Avatar";
import * as Icons from "phosphor-react-native";

const ConversationListItem = ({
  item,
  showDivider,
  router,
  isSelectionMode = false,
  isSelected = false,
  onLongPress,
  onToggleSelection,
}: ConversationListItemProps) => {
  const { user: currentUser } = useAuth();
  const theme = useTheme();

  const openConversation = () => {
    if (isSelectionMode) {
      onToggleSelection?.();
    } else {
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
    }
  };

  const handleLongPress = () => {
    if (!isSelectionMode) {
      onLongPress?.();
    }
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

  const renderAvatar = () => {
    if (isSelectionMode) {
      return (
        <View style={styles.avatarContainer}>
          <Avatar uri={avatar} size={50} isGroup={item.type == "group"} />
          <View style={styles.checkboxOverlay}>
            <Checkbox
              status={isSelected ? 'checked' : 'unchecked'}
              onPress={onToggleSelection}
              theme={{
                colors: {
                  primary: colors.alloGreen,
                  onPrimary: colors.white,
                }
              }}
            />
          </View>
        </View>
      );
    }
    return <Avatar uri={avatar} size={50} isGroup={item.type == "group"} />;
  };

  const renderRight = () => (
    <View style={styles.rightSection}>
      {lastMessage && (
        <Text variant="labelSmall" style={[styles.timeText, { color: colors.timestampText }]}>
          {getLastMessageDate()}
        </Text>
      )}
      {unreadCount > 0 && (
        <Badge
          style={styles.unreadBadge}
          theme={{
            colors: {
              primary: colors.alloGreenLight,
              onPrimary: colors.white,
            }
          }}
        >
          {unreadCount > 99 ? "99+" : unreadCount}
        </Badge>
      )}
    </View>
  );

  const renderDescription = () => (
    <View style={styles.messagePreview}>
      {lastMessage && lastMessage.senderId === currentUser?.id && (
        <Icons.Checks color={colors.timestampText} size={16} style={styles.checkIcon} />
      )}
      <Text
        variant="bodyMedium"
        numberOfLines={1}
        style={[styles.messageText, { color: colors.timestampText }]}
      >
        {getLastMessageContent()}
      </Text>
    </View>
  );

  return (
    <View>
      <TouchableOpacity
        onPress={openConversation}
        onLongPress={handleLongPress}
        style={[
          styles.conversationItem,
          { backgroundColor: theme.colors.surface },
          isSelected && { backgroundColor: theme.colors.surfaceVariant }
        ]}
      >
        <List.Item
          title={isDirect ? otherParticipant?.name : item.name}
          description={renderDescription}
          left={renderAvatar}
          right={renderRight}
          style={styles.listItem}
          titleStyle={styles.titleStyle}
          theme={theme}
        />
      </TouchableOpacity>
      {showDivider && <View style={styles.divider} />}
    </View>
  );
};

export default ConversationListItem;

const styles = StyleSheet.create({
  conversationItem: {
    paddingHorizontal: spacingX._15,
  },
  listItem: {
    paddingHorizontal: 0,
  },
  titleStyle: {
    fontSize: 16,
    fontWeight: "400",
    color: colors.black,
  },
  rightSection: {
    alignItems: "flex-end",
    justifyContent: "center",
    gap: spacingY._5,
  },
  timeText: {
    textAlign: "right",
  },
  messagePreview: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
  },
  checkIcon: {
    marginRight: spacingX._5,
  },
  messageText: {
    flex: 1,
  },
  unreadBadge: {
    marginTop: spacingY._5,
  },
  divider: {
    height: 1,
    backgroundColor: "#E0E0E0",
    marginLeft: spacingX._15 + 50 + spacingX._12, // Avatar width + margins
    marginRight: spacingX._15,
  },
  avatarContainer: {
    position: "relative",
  },
  checkboxOverlay: {
    position: "absolute",
    top: -5,
    right: -5,
    backgroundColor: colors.white,
    borderRadius: 12,
    elevation: 2,
    shadowColor: colors.black,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 2,
  },
});
