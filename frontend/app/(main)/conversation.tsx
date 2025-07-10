import {
  Alert,
  AppState,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import React, { useEffect, useRef, useState } from "react";
import ScreenWrapper from "@/components/ScreenWrapper";
import Header from "@/components/Header";
import { colors, radius, spacingX, spacingY } from "@/constants/theme";
import BackButton from "@/components/BackButton";
import * as Icons from "phosphor-react-native";
import Typo from "@/components/Typo";
import Avatar from "@/components/Avatar";
import Input from "@/components/Input";
import MessageItem from "@/components/MessageItem";
import { useLocalSearchParams } from "expo-router";
import { MessageProps } from "@/types";
import {
  getMessages,
  newMessage,
  markConversationRead,
  messageDelivered,
  messageStatusUpdate,
  bulkMessageStatusUpdate,
  addReaction,
  removeReaction,
  reactionUpdate,
} from "@/socket/socketEvents";
import { useAuth } from "@/contexts/authContext";
import Loading from "@/components/Loading";
import { uploadFileToCloudinary } from "@/services/imageService";
import * as ImagePicker from "expo-image-picker";
import { Audio } from "expo-av";

type ResponseProps = {
  success: boolean;
  data?: any;
  msg?: string;
};

const Conversation = () => {
  const [messages, setMessages] = useState<MessageProps[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<{ uri: string } | null>(null);
  const [showAttachmentOptions, setShowAttachmentOptions] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingUri, setRecordingUri] = useState<string | null>(null);
  const [recording, setRecording] = useState<Audio.Recording | null>(null);

  const { user: currentUser } = useAuth();
  const {
    id: conversationId,
    name: conversationName,
    avatar: conversationAvatar,
    type,
    participants,
  } = useLocalSearchParams();

  const isDirect = type === "direct";
  const flatListRef = useRef<FlatList>(null);
  const inputRef = useRef<TextInput>(null);
  const [sendSound, setSendSound] = useState<Audio.Sound | null>(null);
  const [receiveSound, setReceiveSound] = useState<Audio.Sound | null>(null);

  const getMessageProps = (message: MessageProps, index: number) => {
    const messages_data = messages.length > 0 ? messages : dummyMessages;
    const currentMessage = message;
    const previousMessage = messages_data[index + 1];
    const nextMessage = messages_data[index - 1];

    const isSameSenderAsPrevious = previousMessage &&
      previousMessage.sender.id === currentMessage.sender.id;
    const isSameSenderAsNext = nextMessage &&
      nextMessage.sender.id === currentMessage.sender.id;

    let position: 'single' | 'first' | 'middle' | 'last' = 'single';

    if (isSameSenderAsPrevious && isSameSenderAsNext) {
      position = 'middle';
    } else if (isSameSenderAsPrevious) {
      position = 'last';
    } else if (isSameSenderAsNext) {
      position = 'first';
    }

    const showAvatar = !isDirect && (!isSameSenderAsNext || position === 'single' || position === 'last') && currentMessage.sender.id !== currentUser?.id;

    const timeDifference = previousMessage ?
      new Date(currentMessage.createdAt).getTime() - new Date(previousMessage.createdAt).getTime() :
      Infinity;
    const showTimestamp = !previousMessage || timeDifference > 60000; // 1 minute

    // Show sender name only on first message of group in group chats
    const showSenderName = !isDirect &&
      currentMessage.sender.id !== currentUser?.id &&
      (!isSameSenderAsPrevious || position === 'single' || position === 'first');

    return {
      position,
      showAvatar,
      showTimestamp,
      showSenderName,
    };
  };



  useEffect(() => {
    // Load message sounds
    const loadSounds = async () => {
      try {
        const { sound: sendSoundObj } = await Audio.Sound.createAsync(
          require("@/assets/sounds/send_message.m4a"),
          { shouldPlay: false }
        );
        setSendSound(sendSoundObj);

        const { sound: receiveSoundObj } = await Audio.Sound.createAsync(
          require("@/assets/sounds/receive_message.m4a"),
          { shouldPlay: false }
        );
        setReceiveSound(receiveSoundObj);
      } catch (error) {
        console.log("Error loading sounds:", error);
      }
    };

    loadSounds();
  }, []);

  useEffect(() => {
    if (conversationId) {
      console.log("getting messages");
      getMessages(messagesHandler);
      getMessages({ conversationId });

      // Mark conversation as read
      markConversationRead({ conversationId });

      // Register handlers for real-time updates
      newMessage(newMessageHandler);
      messageStatusUpdate(messageStatusUpdateHandler);
      bulkMessageStatusUpdate(bulkMessageStatusUpdateHandler);
      reactionUpdate(reactionUpdateHandler);
    }

    return () => {
      // Cleanup handlers
      getMessages(messagesHandler, true);
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

  const onPickImage = async () => {
    setShowAttachmentOptions(false);
    let result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.7,
      allowsEditing: true,
    });

    if (!result.canceled) {
      setSelectedFile(result.assets[0]);
    }
  };

  const onTakePhoto = async () => {
    setShowAttachmentOptions(false);
    let result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      quality: 0.7,
      allowsEditing: true,
    });

    if (!result.canceled) {
      setSelectedFile(result.assets[0]);
    }
  };

  const removeSelectedFile = () => {
    setSelectedFile(null);
  };

  const startRecording = async () => {
    try {
      const { status } = await Audio.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission required', 'Please grant microphone permission to record voice messages.');
        return;
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );

      setRecording(recording);
      setIsRecording(true);
    } catch (error) {
      console.error('Failed to start recording:', error);
    }
  };

  const stopRecording = async () => {
    if (!recording) return;

    try {
      setIsRecording(false);
      await recording.stopAndUnloadAsync();
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
      });

      const uri = recording.getURI();
      setRecordingUri(uri);
      setRecording(null);

      // Auto-send voice message
      if (uri) {
        sendVoiceMessage(uri);
      }
    } catch (error) {
      console.error('Failed to stop recording:', error);
    }
  };

  const sendVoiceMessage = async (uri: string) => {
    if (!currentUser) return;

    setLoading(true);
    try {
      const uploadResult = await uploadFileToCloudinary(
        { uri },
        "voice-messages"
      );

      if (uploadResult.success) {
        newMessage({
          conversationId,
          sender: {
            id: currentUser.id,
            name: currentUser.name,
            avatar: currentUser.avatar,
          },
          content: "",
          attachment: uploadResult.data,
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
      }
    } catch (error) {
      console.error("Error sending voice message:", error);
      Alert.alert("Error", "Failed to send voice message");
    } finally {
      setLoading(false);
      setRecordingUri(null);
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
      // Clear the input explicitly and refocus
      if (inputRef.current) {
        inputRef.current.clear();
      }
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

  const renderAttachmentOptions = () => {
    if (!showAttachmentOptions) return null;

    return (
      <View style={styles.attachmentOptions}>
        <TouchableOpacity style={styles.attachmentOption} onPress={onTakePhoto}>
          <View style={[styles.attachmentIcon, { backgroundColor: colors.rose }]}>
            <Icons.Camera color={colors.white} size={24} />
          </View>
          <Typo size={12} style={styles.attachmentLabel}>Camera</Typo>
        </TouchableOpacity>

        <TouchableOpacity style={styles.attachmentOption} onPress={onPickImage}>
          <View style={[styles.attachmentIcon, { backgroundColor: colors.accentBlue }]}>
            <Icons.Image color={colors.white} size={24} />
          </View>
          <Typo size={12} style={styles.attachmentLabel}>Gallery</Typo>
        </TouchableOpacity>

        <TouchableOpacity style={styles.attachmentOption}>
          <View style={[styles.attachmentIcon, { backgroundColor: colors.green }]}>
            <Icons.File color={colors.white} size={24} />
          </View>
          <Typo size={12} style={styles.attachmentLabel}>Document</Typo>
        </TouchableOpacity>
      </View>
    );
  };

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

          {/* Attachment Options */}
          {renderAttachmentOptions()}

          {/* Selected File Preview */}
          {selectedFile && (
            <View style={styles.selectedFileContainer}>
              <Image source={{ uri: selectedFile.uri }} style={styles.selectedFilePreview} />
              <TouchableOpacity onPress={removeSelectedFile} style={styles.removeFileButton}>
                <Icons.X color={colors.white} size={16} />
              </TouchableOpacity>
            </View>
          )}

          {/* Input Area */}
          <View style={styles.inputContainer}>
            <View style={styles.inputWrapper}>
              {/* Emoji Button */}
              <TouchableOpacity style={styles.emojiButton}>
                <Icons.Smiley color={colors.timestampText} size={24} />
              </TouchableOpacity>

              {/* Text Input */}
              <TextInput
                ref={inputRef}
                style={styles.textInput}
                placeholder="Message"
                placeholderTextColor={colors.timestampText}
                value={message}
                onChangeText={setMessage}
                multiline={true}
                maxLength={1000}
                onKeyPress={({ nativeEvent }) => {
                  if (nativeEvent.key === 'Enter') {
                    // Clear any potential trailing spaces or newlines
                    const trimmedMessage = message.trim();
                    if (trimmedMessage) {
                      setMessage(trimmedMessage);
                      setTimeout(() => onSend(), 0);
                    }
                  }
                }}
                blurOnSubmit={false}
                returnKeyType="send"
                enablesReturnKeyAutomatically={true}
              />

              {/* Attachment Button */}
              <TouchableOpacity
                style={styles.attachmentButton}
                onPress={() => setShowAttachmentOptions(!showAttachmentOptions)}
              >
                <Icons.Paperclip color={colors.timestampText} size={24} />
              </TouchableOpacity>
            </View>

            {/* Send/Voice Button */}
            {message.trim() || selectedFile ? (
              <TouchableOpacity style={styles.sendButton} onPress={onSend} disabled={loading}>
                {loading ? (
                  <Loading size="small" color={colors.white} />
                ) : (
                  <Icons.PaperPlaneTilt color={colors.white} weight="fill" size={22} />
                )}
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[styles.voiceButton, isRecording && styles.voiceButtonRecording]}
                onPressIn={startRecording}
                onPressOut={stopRecording}
              >
                <Icons.Microphone
                  color={colors.white}
                  size={22}
                  weight={isRecording ? "fill" : "regular"}
                />
              </TouchableOpacity>
            )}
          </View>

          {/* Recording Indicator */}
          {isRecording && (
            <View style={styles.recordingIndicator}>
              <View style={styles.recordingDot} />
              <Typo color={colors.rose} size={14} fontWeight="500">
                Recording...
              </Typo>
            </View>
          )}
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
  content: {
    flex: 1,
    backgroundColor: colors.chatBackground,
    borderTopLeftRadius: radius._50,
    borderTopRightRadius: radius._50,
    borderCurve: "continuous",
    overflow: "hidden",
    paddingHorizontal: spacingX._15,
  },
  messagesContainer: {
    flex: 1,
  },
  messagesContent: {
    paddingTop: spacingY._15,
    paddingBottom: spacingY._10,
    gap: 1, // Message spacing
  },
  attachmentOptions: {
    flexDirection: "row",
    justifyContent: "space-around",
    backgroundColor: colors.white,
    marginHorizontal: spacingX._20,
    marginBottom: spacingY._10,
    paddingVertical: spacingY._15,
    borderRadius: radius._20,
    elevation: 4,
    shadowColor: colors.black,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  attachmentOption: {
    alignItems: "center",
    gap: spacingY._7,
  },
  attachmentIcon: {
    width: 50,
    height: 50,
    borderRadius: 25,
    alignItems: "center",
    justifyContent: "center",
  },
  attachmentLabel: {
    color: colors.timestampText,
  },
  selectedFileContainer: {
    position: "relative",
    alignSelf: "flex-start",
    marginBottom: spacingY._10,
    marginLeft: spacingX._15,
  },
  selectedFilePreview: {
    width: 80,
    height: 80,
    borderRadius: radius._15,
  },
  removeFileButton: {
    position: "absolute",
    top: -8,
    right: -8,
    backgroundColor: colors.timestampText,
    borderRadius: 12,
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  inputContainer: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: spacingX._10,
    paddingVertical: spacingY._10,
    gap: spacingX._10,
  },
  inputWrapper: {
    flex: 1,
    flexDirection: "row",
    alignItems: "flex-end",
    backgroundColor: colors.white,
    borderRadius: radius._20,
    paddingHorizontal: spacingX._15,
    paddingVertical: spacingY._10,
    minHeight: 50,
  },
  emojiButton: {
    padding: spacingY._5,
    marginRight: spacingX._10,
  },
  textInput: {
    flex: 1,
    fontSize: 16,
    color: colors.black,
    maxHeight: 100,
    paddingVertical: spacingY._5,
    paddingHorizontal: 0,
  },
  attachmentButton: {
    padding: spacingY._5,
    marginLeft: spacingX._10,
  },
  sendButton: {
    backgroundColor: colors.alloGreen,
    width: 50,
    height: 50,
    borderRadius: 25,
    alignItems: "center",
    justifyContent: "center",
  },
  voiceButton: {
    backgroundColor: colors.alloGreen,
    width: 50,
    height: 50,
    borderRadius: 25,
    alignItems: "center",
    justifyContent: "center",
  },
  voiceButtonRecording: {
    backgroundColor: colors.rose,
  },
  recordingIndicator: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacingY._10,
    gap: spacingX._10,
  },
  recordingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.rose,
  },
});
