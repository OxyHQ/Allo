import { StyleSheet, View, TouchableWithoutFeedback } from "react-native";
import React, { useState } from "react";
import { colors, radius, spacingX, spacingY } from "@/constants/theme";
import Avatar from "./Avatar";
import { Text } from "react-native-paper";
import { MessageProps } from "@/types";
import { useAuth } from "@/contexts/authContext";
import moment from "moment";
import { Image } from "expo-image";
import MessageTicks from "./MessageTicks";
import MessageReactions from "./MessageReactions";
import EmojiPicker from "./EmojiPicker";
import CallEventMessage from "./CallEventMessage";

export type MessagePosition = 'single' | 'first' | 'middle' | 'last';

const MessageItem = ({
  item,
  isDirect,
  position = 'single',
  showAvatar = true,
  showTimestamp = true,
  showSenderName = false,
  onReactionAdd,
  onReactionRemove,
  onCallBack,
}: {
  item: MessageProps;
  isDirect: boolean;
  position?: MessagePosition;
  showAvatar?: boolean;
  showTimestamp?: boolean;
  showSenderName?: boolean;
  onReactionAdd?: (messageId: string, emoji: string) => void;
  onReactionRemove?: (messageId: string, emoji: string) => void;
  onCallBack?: (callType: 'audio' | 'video') => void;
}) => {
  const { user: currentUser } = useAuth();
  const isMe = currentUser?.id == item?.sender?.id;

  // State for emoji picker
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [pickerPosition, setPickerPosition] = useState({ x: 0, y: 0 });

  // Format the date using moment (24 hour format)
  const formattedDate = moment(item.createdAt).isSame(moment(), "day")
    ? moment(item.createdAt).format("HH:mm")
    : moment(item.createdAt).format("MMM D, HH:mm");

  // Get bubble radius based on position and message direction
  const getBubbleRadius = () => {
    const baseRadius = 7.5;
    const tightRadius = 3;

    if (position === 'single') {
      return baseRadius;
    }

    if (isMe) {
      // My messages (right side)
      switch (position) {
        case 'first':
          return {
            borderTopLeftRadius: baseRadius,
            borderTopRightRadius: baseRadius,
            borderBottomLeftRadius: baseRadius,
            borderBottomRightRadius: tightRadius,
          };
        case 'middle':
          return {
            borderTopLeftRadius: baseRadius,
            borderTopRightRadius: tightRadius,
            borderBottomLeftRadius: baseRadius,
            borderBottomRightRadius: tightRadius,
          };
        case 'last':
          return {
            borderTopLeftRadius: baseRadius,
            borderTopRightRadius: tightRadius,
            borderBottomLeftRadius: baseRadius,
            borderBottomRightRadius: baseRadius,
          };
        default:
          return baseRadius;
      }
    } else {
      // Other messages (left side)
      switch (position) {
        case 'first':
          return {
            borderTopLeftRadius: baseRadius,
            borderTopRightRadius: baseRadius,
            borderBottomLeftRadius: tightRadius,
            borderBottomRightRadius: baseRadius,
          };
        case 'middle':
          return {
            borderTopLeftRadius: tightRadius,
            borderTopRightRadius: baseRadius,
            borderBottomLeftRadius: tightRadius,
            borderBottomRightRadius: baseRadius,
          };
        case 'last':
          return {
            borderTopLeftRadius: tightRadius,
            borderTopRightRadius: baseRadius,
            borderBottomLeftRadius: baseRadius,
            borderBottomRightRadius: baseRadius,
          };
        default:
          return baseRadius;
      }
    }
  };

  const bubbleRadius = getBubbleRadius();

  // Check if we should show the message tail
  const showTail = position === 'single' || position === 'first';

  // Handle long press to show emoji picker
  const handleLongPress = (event: any) => {
    const { pageX, pageY } = event.nativeEvent;
    setPickerPosition({ x: pageX, y: pageY });
    setShowEmojiPicker(true);
  };

  // Handle emoji selection
  const handleEmojiSelect = (emoji: string) => {
    if (onReactionAdd) {
      onReactionAdd(item.id, emoji);
    }
  };

  // Handle reaction press (remove if user's own, otherwise add)
  const handleReactionPress = (emoji: string) => {
    const userReaction = item.reactions?.find(r => r.userId === currentUser?.id);

    if (userReaction && userReaction.emoji === emoji) {
      // Remove reaction if user clicked their own
      if (onReactionRemove) {
        onReactionRemove(item.id, emoji);
      }
    } else {
      // Add reaction
      if (onReactionAdd) {
        onReactionAdd(item.id, emoji);
      }
    }
  };

  // Get dynamic spacing based on message position
  const getWrapperStyle = () => {
    switch (position) {
      case 'single':
        return [styles.messageWrapper, styles.singleMessage];
      case 'first':
        return [styles.messageWrapper, styles.firstMessage];
      case 'middle':
        return [styles.messageWrapper, styles.middleMessage];
      case 'last':
        return [styles.messageWrapper, styles.lastMessage];
      default:
        return styles.messageWrapper;
    }
  };

  // If this is a call event message, render CallEventMessage component
  if (item.callEvent) {
    return (
      <View style={getWrapperStyle()}>
        <CallEventMessage
          callType={item.callEvent.type}
          callStatus={item.callEvent.status}
          duration={item.callEvent.duration}
          timestamp={formattedDate}
          isMe={isMe}
          onCallBack={() => onCallBack?.(item.callEvent!.type)}
        />
      </View>
    );
  }

  return (
    <View style={getWrapperStyle()}>
      <View
        style={[
          styles.messageContainer,
          isMe ? styles.myMessage : styles.theirMessage,
        ]}
      >
        {/* Avatar for other users - only when showing avatar */}
        {!isMe && !isDirect && showAvatar && (
          <View style={styles.avatarContainer}>
            <Avatar
              size={26}
              uri={item?.sender?.avatar}
              style={styles.messageAvatar}
            />
          </View>
        )}

        <View style={[
          styles.bubbleContainer,
          // Adjust left margin for received messages without avatar
          !isMe && !isDirect && !showAvatar && styles.bubbleContainerNoAvatar
        ]}>
          {/* Sender name for group chats */}
          {!isMe && !isDirect && showSenderName && (
            <Text
              style={[
                styles.senderName,
                { color: "#00a884", fontWeight: "600", fontSize: 13 }
              ]}
            >
              {item.sender.name}
            </Text>
          )}

          <View style={styles.bubbleWrapper}>
            <TouchableWithoutFeedback onLongPress={handleLongPress}>
              <View
                style={[
                  styles.messageBubble,
                  isMe ? styles.myBubble : styles.theirBubble,
                  typeof bubbleRadius === 'number'
                    ? { borderRadius: bubbleRadius }
                    : bubbleRadius,
                ]}
              >
                <View style={styles.messageContent}>
                  {item.attachment && (
                    <Image
                      source={item.attachment}
                      contentFit="cover"
                      style={[
                        styles.attachment,
                        typeof bubbleRadius === 'number'
                          ? { borderRadius: bubbleRadius - 2 }
                          : {
                            borderTopLeftRadius: bubbleRadius.borderTopLeftRadius - 2,
                            borderTopRightRadius: bubbleRadius.borderTopRightRadius - 2,
                            borderBottomLeftRadius: bubbleRadius.borderBottomLeftRadius - 2,
                            borderBottomRightRadius: bubbleRadius.borderBottomRightRadius - 2,
                          }
                      ]}
                      transition={100}
                    />
                  )}

                  <View style={styles.textAndTimestamp}>
                    {item.content && (
                      <Text
                        style={[
                          styles.messageText,
                          { fontSize: 14, color: isMe ? colors.myBubbleText : colors.otherBubbleText }
                        ]}
                      >
                        {item.content}
                      </Text>
                    )}

                    {/* Timestamp and ticks inside bubble */}
                    <View style={styles.timestampAndTicks}>
                      <Text
                        style={[
                          styles.inlineTimestamp,
                          { fontSize: 11, fontWeight: "400", color: colors.timestampText }
                        ]}
                      >
                        {formattedDate}
                      </Text>

                      {/* Show ticks only for sent messages */}
                      {isMe && (
                        <MessageTicks
                          status={item.status || 'sent'}
                          size={12}
                        />
                      )}
                    </View>
                  </View>
                </View>
              </View>
            </TouchableWithoutFeedback>

            {/* Message tail */}
            {showTail && (
              <View
                style={[
                  styles.bubbleTail,
                  isMe ? styles.myBubbleTail : styles.theirBubbleTail,
                ]}
              />
            )}
          </View>

          {/* Message Reactions - positioned below timestamp */}
          <MessageReactions
            reactions={item.reactions}
            onReactionPress={handleReactionPress}
            isMe={isMe}
          />
        </View>
      </View>

      {/* Emoji Picker */}
      <EmojiPicker
        visible={showEmojiPicker}
        onClose={() => setShowEmojiPicker(false)}
        onEmojiSelect={handleEmojiSelect}
        position={pickerPosition}
      />
    </View>
  );
};

export default MessageItem;

const styles = StyleSheet.create({
  messageWrapper: {
    marginVertical: 0.5,
  },
  singleMessage: {
    marginVertical: 2,
  },
  firstMessage: {
    marginTop: 2,
    marginBottom: 0,
  },
  middleMessage: {
    marginVertical: 0,
  },
  lastMessage: {
    marginTop: 0,
    marginBottom: 2,
  },
  messageContainer: {
    flexDirection: "row",
    alignItems: "flex-end",
    maxWidth: "75%",
  },
  myMessage: {
    alignSelf: "flex-end",
    flexDirection: "row-reverse",
  },
  theirMessage: {
    alignSelf: "flex-start",
  },
  avatarContainer: {
    width: 30,
    justifyContent: "flex-end",
  },
  messageAvatar: {
    alignSelf: "flex-end",
  },

  bubbleContainer: {
    flex: 1,
    marginHorizontal: spacingX._5,
  },
  bubbleContainerNoAvatar: {
    marginLeft: 35, // Avatar container width (30) + original margin (5)
  },
  bubbleWrapper: {
    position: 'relative',
  },
  senderName: {
    marginBottom: 1,
    marginLeft: 2,
  },
  messageBubble: {
    paddingHorizontal: 7,
    paddingVertical: 6,
    paddingRight: 8,
    maxWidth: "100%",
    minWidth: 20,
    // Message bubble shadow
    shadowColor: "#000",
    shadowOffset: {
      width: 0,
      height: 0.5,
    },
    shadowOpacity: 0.13,
    shadowRadius: 1,
    elevation: 1,
  },
  myBubble: {
    backgroundColor: colors.myBubble,
  },
  theirBubble: {
    backgroundColor: colors.otherBubble,
    borderWidth: 0.5,
    borderColor: "#e0e0e0",
  },
  bubbleTail: {
    position: 'absolute',
    top: 0,
    width: 0,
    height: 0,
  },
  myBubbleTail: {
    right: -5,
    borderLeftWidth: 6,
    borderBottomWidth: 6,
    borderLeftColor: colors.myBubble,
    borderBottomColor: 'transparent',
  },
  theirBubbleTail: {
    left: -5,
    borderRightWidth: 6,
    borderBottomWidth: 6,
    borderRightColor: colors.otherBubble,
    borderBottomColor: 'transparent',
  },
  messageContent: {
    flexDirection: 'column',
  },
  textAndTimestamp: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
  },
  messageText: {
    fontSize: 14,
    lineHeight: 19,
    flex: 1,
    marginRight: 4,
  },
  timestampAndTicks: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-end',
    marginLeft: 4,
    marginTop: 2,
  },
  inlineTimestamp: {
    fontSize: 11,
    color: colors.timestampText,
  },
  attachment: {
    maxWidth: "100%",
    aspectRatio: 1,
    alignSelf: "center",
    marginBottom: spacingY._5,
  },

});
