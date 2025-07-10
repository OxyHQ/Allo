import {
  StyleSheet,
  View,
  TouchableOpacity,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Keyboard,
  Alert,
  TextInput,
  AppState,
} from "react-native";
import React, { useEffect, useRef, useState } from "react";
import ScreenWrapper from "@/components/ScreenWrapper";
import Header from "@/components/Header";
import { colors, radius, spacingX, spacingY } from "@/constants/theme";
import BackButton from "@/components/BackButton";
import Avatar from "@/components/Avatar";
import Typo from "@/components/Typo";
import { getAvatarPath } from "@/services/imageService";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as Icons from "phosphor-react-native";
import { useAuth } from "@/contexts/authContext";
import Input from "@/components/Input";
import MessageItem, { MessagePosition } from "@/components/MessageItem";
import { getMessages, newMessage, messageStatusUpdate, messageDelivered, messageRead, markConversationRead, bulkMessageStatusUpdate, addReaction, removeReaction, reactionUpdate } from "@/socket/socketEvents";
import { MessageProps, ResponseProps } from "@/types";
import * as ImagePicker from "expo-image-picker";
import { uploadFileToCloudinary } from "@/services/imageService";
import { Image } from "expo-image";
import Loading from "@/components/Loading";
import { Audio } from "expo-av";

const Conversation = () => {
  const router = useRouter();
  const flatListRef = useRef<FlatList>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<MessageProps[]>([]);
  const { user: currentUser } = useAuth();
  const {
    id: conversationId,
    name,
    participants: stringifiedParticipants,
    avatar,
    type,
  } = useLocalSearchParams();

  const participants = JSON.parse(stringifiedParticipants as string);
  let conversationAvatar = avatar;
  let isDirect = type == "direct";

  const otherParticipant = isDirect
    ? participants.find((p: any) => p._id !== currentUser?.id)
    : null;

  if (isDirect && otherParticipant)
    conversationAvatar = otherParticipant?.avatar;

  let conversationName = isDirect ? otherParticipant?.name : name;

  const [selectedFile, setSelectedFile] = useState<{ uri: string } | null>(
    null
  );

  // Sound objects for message notifications
  const [sendSound, setSendSound] = useState<Audio.Sound | null>(null);
  const [receiveSound, setReceiveSound] = useState<Audio.Sound | null>(null);

  // Message grouping logic - determines position and display properties for each message
  const getMessageProps = (message: MessageProps, index: number) => {
    const currentMessage = message;
    const previousMessage = messages[index + 1]; // Note: inverted list
    const nextMessage = messages[index - 1]; // Note: inverted list

    const isSameSenderAsPrevious = previousMessage &&
      previousMessage.sender.id === currentMessage.sender.id;
    const isSameSenderAsNext = nextMessage &&
      nextMessage.sender.id === currentMessage.sender.id;

    // Determine if messages are close in time (within 2 minutes)
    const isCloseTimeToPrevious = previousMessage &&
      Math.abs(new Date(currentMessage.createdAt).getTime() - new Date(previousMessage.createdAt).getTime()) < 2 * 60 * 1000;
    const isCloseTimeToNext = nextMessage &&
      Math.abs(new Date(currentMessage.createdAt).getTime() - new Date(nextMessage.createdAt).getTime()) < 2 * 60 * 1000;

    const shouldGroupWithPrevious = isSameSenderAsPrevious && isCloseTimeToPrevious;
    const shouldGroupWithNext = isSameSenderAsNext && isCloseTimeToNext;

    let position: MessagePosition = 'single';

    if (shouldGroupWithPrevious && shouldGroupWithNext) {
      position = 'middle';
    } else if (shouldGroupWithPrevious) {
      position = 'last';
    } else if (shouldGroupWithNext) {
      position = 'first';
    } else {
      position = 'single';
    }

    // For received messages, show avatar only on last message of group
    const showAvatar = position === 'single' || position === 'last';

    // Show timestamp only on last message of group or single messages
    const showTimestamp = position === 'single' || position === 'last';

    // Show sender name only on first message of group in group chats
    const showSenderName = !isDirect && (position === 'single' || position === 'first');

    return {
      position,
      showAvatar,
      showTimestamp,
      showSenderName,
    };
  };

  const inputRef = useRef<TextInput>(null) as React.RefObject<TextInput>;

  useEffect(() => {
    // Load sound files
    const loadSounds = async () => {
      try {
        // Set audio mode for proper playback
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          staysActiveInBackground: false,
          playsInSilentModeIOS: true,
          shouldDuckAndroid: true,
          playThroughEarpieceAndroid: false,
        });

        const { sound: sendSnd } = await Audio.Sound.createAsync(
          require("@/assets/sounds/send_message.m4a"),
          { shouldPlay: false }
        );
        const { sound: receiveSnd } = await Audio.Sound.createAsync(
          require("@/assets/sounds/receive_message.m4a"),
          { shouldPlay: false }
        );

        setSendSound(sendSnd);
        setReceiveSound(receiveSnd);
      } catch (error) {
        console.log("Error loading sounds:", error);
      }
    };

    loadSounds();

    // Initial scroll to bottom
    newMessage(newMessageHandler);
    getMessages(messagesHandler);
    getMessages({ conversationId });

    // Message status event handlers
    messageStatusUpdate(messageStatusUpdateHandler);
    bulkMessageStatusUpdate(bulkMessageStatusUpdateHandler);

    // Reaction event handlers
    reactionUpdate(reactionUpdateHandler);

    // Mark conversation as read when opening
    markConversationRead({ conversationId });

    return () => {
      newMessage(newMessageHandler, true);
      messageStatusUpdate(messageStatusUpdateHandler, true);
      bulkMessageStatusUpdate(bulkMessageStatusUpdateHandler, true);
      reactionUpdate(reactionUpdateHandler, true);
    };
  }, []);

  // Cleanup sounds on component unmount
  useEffect(() => {
    return () => {
      if (sendSound) {
        sendSound.unloadAsync();
      }
      if (receiveSound) {
        receiveSound.unloadAsync();
      }
    };
  }, [sendSound, receiveSound]);

  // Handle app state changes to mark messages as read when app becomes active
  useEffect(() => {
    const handleAppStateChange = (nextAppState: string) => {
      if (nextAppState === 'active') {
        // Mark all messages as read when returning to the app
        markConversationRead({ conversationId });
      }
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => subscription?.remove();
  }, [conversationId]);

  const messagesHandler = (res: ResponseProps) => {
    if (res.success) {
      setMessages(res.data);
    }
  };

  const newMessageHandler = (res: ResponseProps) => {
    setLoading(false);
    // console.log("got new message in home screen: ", res);
    if (res.success) {
      if (res.data.conversationId == conversationId) {
        setMessages((prevState) => [res.data as MessageProps, ...prevState]);

        // Play receive sound if message is from another user
        if (res.data.sender.id !== currentUser?.id && receiveSound) {
          receiveSound.getStatusAsync().then(status => {
            if (status.isLoaded) {
              receiveSound.playFromPositionAsync(0).catch(error => {
                console.log("Error playing receive sound:", error);
              });
            }
          });
        }

        // Mark message as delivered if it's from another user
        if (res.data.sender.id !== currentUser?.id) {
          messageDelivered({
            messageId: res.data.id,
            conversationId: conversationId
          });
        }
      }
    } else {
      Alert.alert("Error", res.msg);
    }
  };

  const messageStatusUpdateHandler = (data: { messageId: string; status: string; updatedBy: string }) => {
    // Update message status in the local state
    setMessages(prevMessages =>
      prevMessages.map(message =>
        message.id === data.messageId
          ? { ...message, status: data.status as 'sent' | 'delivered' | 'read' }
          : message
      )
    );
  };

  const bulkMessageStatusUpdateHandler = (data: { messageIds: string[]; status: string; updatedBy: string }) => {
    // Update multiple messages status in the local state
    setMessages(prevMessages =>
      prevMessages.map(message =>
        data.messageIds.includes(message.id)
          ? { ...message, status: data.status as 'sent' | 'delivered' | 'read' }
          : message
      )
    );
  };

  const reactionUpdateHandler = (data: { messageId: string; reactions: any[]; updatedBy: any }) => {
    // Update message reactions in the local state
    setMessages(prevMessages =>
      prevMessages.map(message =>
        message.id === data.messageId
          ? { ...message, reactions: data.reactions }
          : message
      )
    );
  };

  const handleReactionAdd = (messageId: string, emoji: string) => {
    addReaction({
      messageId,
      emoji,
      conversationId
    });
  };

  const handleReactionRemove = (messageId: string, emoji: string) => {
    removeReaction({
      messageId,
      conversationId
    });
  };

  const onPickFile = async () => {
    let result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      aspect: [4, 3],
      quality: 0.5,
    });

    if (!result.canceled) {
      setSelectedFile(result.assets[0]);
    }
  };

  const onSend = async () => {
    // Don't allow sending if both message and file are empty
    if (!message.trim() && !selectedFile) return;
    if (!currentUser) return;

    setLoading(true);
    try {
      let attachment = null;
      if (selectedFile) {
        const uploadResult = await uploadFileToCloudinary(
          selectedFile,
          "message-attachments"
        );
        if (uploadResult.success) {
          attachment = uploadResult.data;
        } else {
          setLoading(false);
          Alert.alert("Error", "Could not send the file!");
          return;
        }
      }

      newMessage({
        conversationId,
        sender: {
          id: currentUser.id,
          name: currentUser.name,
          avatar: currentUser.avatar,
        },
        content: message.trim(),
        attachment,
        status: 'sent',
      });

      // Play send sound
      if (sendSound) {
        sendSound.getStatusAsync().then(status => {
          if (status.isLoaded) {
            sendSound.playFromPositionAsync(0).catch(error => {
              console.log("Error playing send sound:", error);
            });
          }
        });
      }

      setMessage("");
      setSelectedFile(null);
      // Focus the input after sending (with delay for all platforms)
      setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
    } catch (error) {
      console.error("Error sending message:", error);
      Alert.alert("Error", "Failed to send message");
    } finally {
      setLoading(false);
    }
  };

  // Dummy messages for now
  const dummyMessages = [
    {
      id: "msg_10",
      sender: {
        id: "user_2",
        name: "Jane Smith",
        avatar: null,
      },
      content: "That would be really useful!",
      createdAt: "10:42 AM",
      isMe: false,
    },
    {
      id: "msg_9",
      sender: {
        id: "me",
        name: "Me",
        avatar: null,
      },
      content:
        "Yes, I'm thinking about adding message reactions and file sharing.",
      createdAt: "10:41 AM",
      isMe: true,
      status: "read" as const,
      reactions: [
        {
          userId: "user_1",
          emoji: "👍",
          createdAt: "10:42 AM"
        },
        {
          userId: "user_2",
          emoji: "❤️",
          createdAt: "10:42 AM"
        }
      ],
    },
    {
      id: "msg_8",
      sender: {
        id: "user_1",
        name: "John Doe",
        avatar: null,
      },
      content: "Are you planning to add any special features?",
      createdAt: "10:40 AM",
      isMe: false,
    },
    {
      id: "msg_7",
      sender: {
        id: "me",
        name: "Me",
        avatar: null,
      },
      content: "Thanks! I'm trying to make it as user-friendly as possible.",
      createdAt: "10:38 AM",
      isMe: true,
      status: "delivered" as const,
    },
    {
      id: "msg_6",
      sender: {
        id: "user_2",
        name: "Jane Smith",
        avatar: null,
      },
      content: "The UI looks really clean so far.",
      createdAt: "10:37 AM",
      isMe: false,
      reactions: [
        {
          userId: "me",
          emoji: "😂",
          createdAt: "10:38 AM"
        }
      ],
    },
    {
      id: "msg_5",
      sender: {
        id: "user_1",
        name: "John Doe",
        avatar: null,
      },
      content: "Looking forward to testing it out!",
      createdAt: "10:36 AM",
      isMe: false,
    },
    {
      id: "msg_4",
      sender: {
        id: "me",
        name: "Me",
        avatar: null,
      },
      content: "I'm working on the chat feature right now.",
      createdAt: "10:35 AM",
      isMe: true,
      status: "sent" as const,
    },
    {
      id: "msg_3",
      sender: {
        id: "user_2",
        name: "Jane Smith",
        avatar: null,
      },
      content: "That's awesome! Can't wait to see it in action.",
      createdAt: "10:33 AM",
      isMe: false,
    },
    {
      id: "msg_2",
      sender: {
        id: "me",
        name: "Me",
        avatar: null,
      },
      content: "I'm doing great!",
      createdAt: "10:32 AM",
      isMe: true,
      status: "read" as const,
    },
    {
      id: "msg_1",
      sender: {
        id: "user_1",
        name: "John Doe",
        avatar: null,
      },
      content: "Hey everyone! How's it going?",
      createdAt: "10:30 AM",
      isMe: false,
    },
  ];

  return (
    <ScreenWrapper showPattern={true} bgOpacity={0.4}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.container}
      >
        {/* header */}
        <Header
          style={styles.header}
          leftIcon={
            <View style={styles.headerLeft}>
              <BackButton />
              <Avatar
                size={40}
                uri={conversationAvatar as string}
                isGroup={type === "group"}
              />
              <Typo color={colors.white} fontWeight={"500"} size={22}>
                {conversationName}
              </Typo>
            </View>
          }
          rightIcon={
            <TouchableOpacity>
              <Icons.DotsThreeOutlineVertical
                weight="fill"
                color={colors.white}
              />
            </TouchableOpacity>
          }
        />

        {/* messages */}
        <View style={styles.content}>
          <FlatList
            ref={flatListRef}
            data={messages.length > 0 ? messages : dummyMessages}
            inverted={true}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.messagesContent}
            renderItem={({ item, index }) => {
              const messageProps = getMessageProps(item, index);
              return (
                <MessageItem
                  item={item}
                  isDirect={isDirect}
                  position={messageProps.position}
                  showAvatar={messageProps.showAvatar}
                  showTimestamp={messageProps.showTimestamp}
                  showSenderName={messageProps.showSenderName}
                  onReactionAdd={handleReactionAdd}
                  onReactionRemove={handleReactionRemove}
                />
              );
            }}
            keyExtractor={(item) => item.id}
          />
          <View style={styles.footer}>
            <Input
              value={message}
              onChangeText={setMessage}
              onSubmitEditing={onSend}
              inputRef={inputRef}
              containerStyle={{
                paddingLeft: spacingX._10,
                paddingRight: 65,
                borderWidth: 0,
              }}
              placeholder="Type message"
              icon={
                <TouchableOpacity style={styles.inputIcon} onPress={onPickFile}>
                  <Icons.Plus
                    color={colors.black}
                    weight="bold"
                    size={22}
                  />
                  {selectedFile && selectedFile.uri && (
                    <Image
                      source={selectedFile.uri}
                      style={styles.selectedFile}
                    />
                  )}
                </TouchableOpacity>
              }
            />

            <View style={styles.inputRightIcon}>
              <TouchableOpacity style={styles.inputIcon} onPress={onSend}>
                {loading ? (
                  <Loading size="small" color={colors.black} />
                ) : (
                  <Icons.PaperPlaneTilt
                    color={colors.black}
                    weight="fill"
                    size={22}
                  />
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </ScreenWrapper>
  );
};

export default Conversation;

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },

  header: {
    paddingHorizontal: spacingX._15,
    paddingTop: spacingY._10,
    paddingBottom: spacingY._15,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacingX._12,
  },
  inputRightIcon: {
    position: "absolute",
    right: 10,
    top: 15,
    paddingLeft: spacingX._12,
    borderLeftWidth: 1.5,
    borderLeftColor: colors.neutral300,
  },
  selectedFile: {
    position: "absolute",
    height: 38,
    width: 38,
    borderRadius: radius.full,
    alignSelf: "center",
  },
  content: {
    flex: 1,
    backgroundColor: colors.chatBackground,
    borderTopLeftRadius: radius._50,
    borderTopRightRadius: radius._50,
    borderCurve: "continuous",
    overflow: "hidden",
    paddingHorizontal: spacingX._15,
  },

  inputIcon: {
    backgroundColor: colors.primary,
    borderRadius: radius.full,
    padding: 8,
  },

  footer: {
    paddingTop: spacingY._7,
    paddingBottom: 22,
  },
  messagesContainer: {
    flex: 1,
  },
  messagesContent: {
    paddingTop: spacingY._15,
    paddingBottom: spacingY._10,
    gap: 1, // WhatsApp exact message spacing
  },

  plusIcon: {
    backgroundColor: colors.primary,
    borderRadius: radius.full,
    padding: 8,
  },
});
