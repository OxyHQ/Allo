import { colors, spacingX, spacingY } from "@/constants/theme";
import { useAuth } from "@/contexts/authContext";
import { ConversationListItemProps } from "@/types";
import moment from "moment";
import React from "react";
import { StyleSheet, TouchableOpacity, View } from "react-native";
import Avatar from "./Avatar";
import Typo from "./Typo";

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
    if (!lastMessage) return "Say hi 👋";
    return lastMessage.attachment ? "Image" : lastMessage.content;
  };

  const getLastMessageDate = () => {
    if (!lastMessage?.createdAt) return null;

    const messageDate = moment(lastMessage.createdAt);
    const today = moment();

    if (messageDate.isSame(today, "day")) {
      return messageDate.format("h:mm A");
    }

    if (messageDate.isSame(today, "year")) {
      return messageDate.format("MMM D");
    }

    return messageDate.format("MMM D, YYYY");
  };
  return (
    <View>
      <TouchableOpacity
        style={styles.conversationItem}
        onPress={openConversation}
      >
        <View>
          <Avatar uri={avatar} size={40} isGroup={item.type == "group"} />
        </View>

        <View style={{ flex: 1 }}>
          <View style={styles.row}>
            <Typo size={17} fontWeight={"600"}>
              {isDirect ? otherParticipant?.name : item.name}
            </Typo>
            {item.lastMessage && <Typo size={15}>{getLastMessageDate()}</Typo>}
            {/* <Typo size={15}>23 jun</Typo> */}
          </View>

          <Typo
            size={15}
            color={colors.neutral600}
            textProps={{ numberOfLines: 1 }}
          >
            {getLastMessageContent()}
            {/* Say hi 👋 */}
          </Typo>
        </View>
      </TouchableOpacity>

      {showDivider && <View style={styles.divider} />}
    </View>
  );
};

export default ConversationListItem;

const styles = StyleSheet.create({
  conversationItem: {
    gap: spacingX._10,
    marginVertical: spacingY._12,
    flexDirection: "row",
    alignItems: "center",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  divider: {
    height: 1,
    width: "95%",
    alignSelf: "center",
    backgroundColor: "rgba(0,0,0,0.07)",
  },
});
