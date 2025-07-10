import {
  Alert,
  Animated,
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
  startTyping,
  stopTyping,
  userStartedTyping,
  userStoppedTyping,
  initiateCall,
} from "@/socket/socketEvents";
import { useAuth } from "@/contexts/authContext";
import { useCallHistory } from "@/contexts/callHistoryContext";
import { useGlobalCall } from "@/contexts/globalCallContext";
import Loading from "@/components/Loading";
import { uploadFileToCloudinary } from "@/services/imageService";
import * as ImagePicker from "expo-image-picker";
import { Audio } from "expo-av";
import CallManager from "@/components/CallManager";

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
  const [typingUsers, setTypingUsers] = useState<Map<string, string>>(new Map());
  const [isOnline, setIsOnline] = useState(true);
  const [lastSeen, setLastSeen] = useState("2 minutes ago");
  const [showCallManager, setShowCallManager] = useState(false);
  const [callInitData, setCallInitData] = useState<{
    callType: 'audio' | 'video';
    callerId: string;
    callerName: string;
  } | null>(null);

  // Animated values for typing dots (optimized with useNativeDriver)
  const dot1Opacity = useRef(new Animated.Value(0.3)).current;
  const dot2Opacity = useRef(new Animated.Value(0.3)).current;
  const dot3Opacity = useRef(new Animated.Value(0.3)).current;

  // Performance optimizations
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTypingRef = useRef(false);

  const { user: currentUser } = useAuth();
  const { addCallToHistory } = useCallHistory();
  const { initializeCallManager } = useGlobalCall();
  const {
    id: conversationId,
    name: conversationName,
    avatar: conversationAvatar,
    type,
    participants,
    acceptedCall,
    callType,
    callId,
    callerId,
    callerName,
  } = useLocalSearchParams();

  const isDirect = type === "direct";
  const flatListRef = useRef<FlatList>(null);
  const inputRef = useRef<TextInput>(null);
  const [sendSound, setSendSound] = useState<Audio.Sound | null>(null);
  const [receiveSound, setReceiveSound] = useState<Audio.Sound | null>(null);

  const getMessageProps = (message: MessageProps, index: number) => {
    const currentMessage = message;
    const previousMessage = messages[index + 1];
    const nextMessage = messages[index - 1];

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



  // Helper function to get username from participants
  const getUserNameById = (userId: string): string => {
    try {
      if (typeof participants === 'string') {
        const participantsList = JSON.parse(participants);
        const participant = participantsList.find((p: any) => p._id === userId);
        return participant?.name || 'Unknown User';
      }
    } catch (error) {
      console.error('Error parsing participants:', error);
    }
    return 'Unknown User';
  };

  // Real-time typing handlers
  const handleUserStartedTyping = (data: { userId: string; conversationId: string }) => {
    if (data.conversationId === conversationId && data.userId !== currentUser?.id) {
      setTypingUsers(prev => {
        const newMap = new Map(prev);
        const userName = getUserNameById(data.userId);
        newMap.set(data.userId, userName);
        return newMap;
      });
    }
  };

  const handleUserStoppedTyping = (data: { userId: string; conversationId: string }) => {
    if (data.conversationId === conversationId) {
      setTypingUsers(prev => {
        const newMap = new Map(prev);
        newMap.delete(data.userId);
        return newMap;
      });
    }
  };

  // Initialize call manager with conversation details for global call context
  useEffect(() => {
    if (conversationId && conversationName && typeof conversationAvatar === 'string') {
      const participantIds = typeof participants === 'string' ? participants.split(',') : [];
      initializeCallManager(
        conversationId as string,
        conversationName as string,
        conversationAvatar,
        isDirect,
        participantIds
      );
    }
  }, [conversationId, conversationName, conversationAvatar, isDirect, participants, initializeCallManager]);

  // Handle accepted call from global manager
  useEffect(() => {
    if (acceptedCall === 'true' && callType && callerId && callerName) {
      // Show call manager to continue the accepted call
      setShowCallManager(true);

      // Set appropriate call state for accepted call
      setCallInitData({
        callType: callType as 'audio' | 'video',
        callerId: callerId as string,
        callerName: callerName as string,
      });

      // Add incoming call message to conversation
      addCallEventMessage(callType as 'audio' | 'video', 'incoming');
    }
  }, [acceptedCall, callType, callerId, callerName]);

  // Efficient typing detection with debouncing
  const handleTypingChange = (text: string) => {
    setMessage(text);

    if (!text.trim()) {
      // User cleared text, stop typing
      if (isTypingRef.current) {
        stopTyping({ conversationId });
        isTypingRef.current = false;
      }
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }
      return;
    }

    // User is typing
    if (!isTypingRef.current) {
      startTyping({ conversationId });
      isTypingRef.current = true;
    }

    // Reset the timeout
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    // Stop typing after 3 seconds of inactivity
    typingTimeoutRef.current = setTimeout(() => {
      if (isTypingRef.current) {
        stopTyping({ conversationId });
        isTypingRef.current = false;
      }
    }, 3000);
  };

  // Typing animation effect (optimized)
  useEffect(() => {
    if (typingUsers.size > 0) {
      // Start pulsing animation
      const createPulseAnimation = (animatedValue: Animated.Value, delay: number) => {
        return Animated.loop(
          Animated.sequence([
            Animated.timing(animatedValue, {
              toValue: 1,
              duration: 400,
              delay,
              useNativeDriver: true,
            }),
            Animated.timing(animatedValue, {
              toValue: 0.3,
              duration: 400,
              useNativeDriver: true,
            }),
          ])
        );
      };

      const animation1 = createPulseAnimation(dot1Opacity, 0);
      const animation2 = createPulseAnimation(dot2Opacity, 200);
      const animation3 = createPulseAnimation(dot3Opacity, 400);

      animation1.start();
      animation2.start();
      animation3.start();

      return () => {
        animation1.stop();
        animation2.stop();
        animation3.stop();
      };
    } else {
      // Reset opacity when not typing
      dot1Opacity.setValue(0.3);
      dot2Opacity.setValue(0.3);
      dot3Opacity.setValue(0.3);
    }
  }, [typingUsers.size, dot1Opacity, dot2Opacity, dot3Opacity]);

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
      userStartedTyping(handleUserStartedTyping);
      userStoppedTyping(handleUserStoppedTyping);
      // Note: Removed incomingCall handler as it's now handled globally
    }

    return () => {
      // Cleanup handlers
      getMessages(messagesHandler, true);
      newMessage(newMessageHandler, true);
      messageStatusUpdate(messageStatusUpdateHandler, true);
      bulkMessageStatusUpdate(bulkMessageStatusUpdateHandler, true);
      reactionUpdate(reactionUpdateHandler, true);
      userStartedTyping(handleUserStartedTyping, true);
      userStoppedTyping(handleUserStoppedTyping, true);
      // Note: Removed incomingCall cleanup as it's now handled globally

      // Cleanup typing state
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
      if (isTypingRef.current) {
        stopTyping({ conversationId });
      }
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

      // Final cleanup of typing state
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
      if (isTypingRef.current && conversationId) {
        stopTyping({ conversationId });
      }
    };
  }, [sendSound, receiveSound, conversationId]);

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

  // Handle call back from call event messages
  const handleCallBack = (callType: 'audio' | 'video') => {
    if (callType === 'video') {
      startVideoCall();
    } else {
      startAudioCall();
    }
  };

  // Add call event message to conversation
  const addCallEventMessage = (
    callType: 'audio' | 'video',
    status: 'missed' | 'incoming' | 'outgoing',
    duration?: string
  ) => {
    const callMessage: MessageProps = {
      id: `call_${Date.now()}_${Math.random()}`,
      sender: {
        id: currentUser?.id || 'unknown',
        name: currentUser?.name || 'Unknown',
        avatar: currentUser?.avatar || null,
      },
      content: '',
      createdAt: new Date().toISOString(),
      callEvent: {
        type: callType,
        status,
        duration,
      },
    };

    setMessages(prevMessages => [callMessage, ...prevMessages]);
  };

  // Update call message with duration when call ends
  const updateCallEventMessage = (callId: string, duration: string) => {
    setMessages(prevMessages =>
      prevMessages.map(message =>
        message.id === callId && message.callEvent
          ? { ...message, callEvent: { ...message.callEvent, duration } }
          : message
      )
    );
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

  // Call functions
  const startVideoCall = () => {
    if (!currentUser?.id || !conversationId) return;

    const callData = {
      callType: 'video' as const,
      callerId: currentUser.id,
      callerName: currentUser.name || 'Unknown',
    };

    setCallInitData(callData);
    setShowCallManager(true);

    // Add outgoing call message
    addCallEventMessage('video', 'outgoing');

    // Add to global call history
    addCallToHistory({
      conversationId: conversationId as string,
      conversationName: conversationName as string,
      conversationAvatar: conversationAvatar as string,
      callType: 'video',
      status: 'outgoing',
      timestamp: new Date().toISOString(),
      participants: typeof participants === 'string' ? participants.split(',') : [currentUser.id],
      isDirect: isDirect,
    });

    initiateCall({
      conversationId,
      callType: 'video',
      callerId: currentUser.id,
      callerName: currentUser.name || 'Unknown',
    });
  };

  const startAudioCall = () => {
    if (!currentUser?.id || !conversationId) return;

    const callData = {
      callType: 'audio' as const,
      callerId: currentUser.id,
      callerName: currentUser.name || 'Unknown',
    };

    setCallInitData(callData);
    setShowCallManager(true);

    // Add outgoing call message
    addCallEventMessage('audio', 'outgoing');

    // Add to global call history
    addCallToHistory({
      conversationId: conversationId as string,
      conversationName: conversationName as string,
      conversationAvatar: conversationAvatar as string,
      callType: 'audio',
      status: 'outgoing',
      timestamp: new Date().toISOString(),
      participants: typeof participants === 'string' ? participants.split(',') : [currentUser.id],
      isDirect: isDirect,
    });

    initiateCall({
      conversationId,
      callType: 'audio',
      callerId: currentUser.id,
      callerName: currentUser.name || 'Unknown',
    });
  };

  const closeCallManager = (callInfo?: { duration?: string; callType?: 'audio' | 'video' }) => {
    setShowCallManager(false);
    setCallInitData(null);

    // Update the most recent call message with actual duration if call was connected
    if (callInfo?.duration) {
      // Find the most recent outgoing call message of the same type and update it
      setMessages(prevMessages => {
        const messageIndex = prevMessages.findIndex(
          msg => msg.callEvent?.type === callInfo.callType &&
            msg.callEvent?.status === 'outgoing' &&
            msg.sender.id === currentUser?.id &&
            !msg.callEvent?.duration
        );

        if (messageIndex !== -1) {
          const updatedMessages = [...prevMessages];
          updatedMessages[messageIndex] = {
            ...updatedMessages[messageIndex],
            callEvent: {
              ...updatedMessages[messageIndex].callEvent!,
              duration: callInfo.duration,
            }
          };
          return updatedMessages;
        }
        return prevMessages;
      });
    }
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

    // Stop typing immediately when sending
    if (isTypingRef.current) {
      stopTyping({ conversationId });
      isTypingRef.current = false;
    }
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }

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

  // Render empty state when no messages
  const renderEmptyState = () => {
    if (loading) return null;

    return (
      <View style={styles.emptyStateContainer}>
        <View style={styles.emptyStateContent}>
          <Icons.ChatCircle
            color={colors.timestampText}
            size={48}
            style={styles.emptyStateIcon}
          />
          <Typo
            size={16}
            color={colors.timestampText}
            style={styles.emptyStateText}
          >
            No messages yet
          </Typo>
          <Typo
            size={14}
            color={colors.timestampText}
            style={styles.emptyStateSubtext}
          >
            Send a message to start the conversation
          </Typo>
        </View>
      </View>
    );
  };

  const renderTypingIndicator = () => {
    if (typingUsers.size === 0) return null;

    const typingUserNames = Array.from(typingUsers.values());
    return (
      <View style={styles.typingContainer}>
        <View style={styles.typingDots}>
          <View style={[styles.typingDot, styles.typingDot1]} />
          <View style={[styles.typingDot, styles.typingDot2]} />
          <View style={[styles.typingDot, styles.typingDot3]} />
        </View>
        <Typo color={colors.white} size={12} style={styles.typingText}>
          {typingUsers.size === 1
            ? `${typingUserNames[0]} is typing...`
            : `${typingUsers.size} people are typing...`
          }
        </Typo>
      </View>
    );
  };

  const renderMessageTypingBubble = () => {
    if (typingUsers.size === 0) return null;

    return (
      <View style={styles.typingBubbleContainer}>
        {!isDirect && (
          <Avatar
            size={24}
            uri={null}
            style={styles.typingAvatar}
          />
        )}
        <View style={styles.typingBubble}>
          <View style={styles.typingDotsMessage}>
            <Animated.View style={[styles.typingDotMessage, { opacity: dot1Opacity }]} />
            <Animated.View style={[styles.typingDotMessage, { opacity: dot2Opacity }]} />
            <Animated.View style={[styles.typingDotMessage, { opacity: dot3Opacity }]} />
          </View>
        </View>
      </View>
    );
  };

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
              <View style={styles.headerInfo}>
                <Typo color={colors.white} fontWeight={"500"} size={18}>
                  {conversationName}
                </Typo>
                {typingUsers.size > 0 ? (
                  renderTypingIndicator()
                ) : (
                  <Typo color={colors.white} size={12} style={styles.statusText}>
                    {isDirect
                      ? (isOnline ? "online" : `last seen ${lastSeen}`)
                      : `${participants ? (participants as string).split(',').length : 2} participants`
                    }
                  </Typo>
                )}
              </View>
            </View>
          }
          rightIcon={
            <View style={styles.headerRight}>
              <TouchableOpacity style={styles.headerIconButton} onPress={startVideoCall}>
                <Icons.VideoCamera color={colors.white} size={22} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.headerIconButton} onPress={startAudioCall}>
                <Icons.Phone color={colors.white} size={22} />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.headerIconButton}
                onPress={() => {
                  // Open conversation settings/menu
                  console.log('Opening conversation menu');
                }}
              >
                <Icons.DotsThreeOutlineVertical
                  weight="fill"
                  color={colors.white}
                  size={22}
                />
              </TouchableOpacity>
            </View>
          }
        />

        {/* messages */}
        <View style={styles.content}>
          <FlatList
            ref={flatListRef}
            data={messages}
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
                  onCallBack={handleCallBack}
                />
              );
            }}
            keyExtractor={(item) => item.id}
            ListHeaderComponent={renderMessageTypingBubble}
            ListEmptyComponent={renderEmptyState}
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
                onChangeText={handleTypingChange}
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

      {/* Call Manager */}
      <CallManager
        visible={showCallManager}
        onClose={closeCallManager}
        conversationId={Array.isArray(conversationId) ? conversationId[0] : conversationId}
        conversationName={Array.isArray(conversationName) ? conversationName[0] : conversationName}
        conversationAvatar={Array.isArray(conversationAvatar) ? conversationAvatar[0] : conversationAvatar}
        isDirect={isDirect}
        initiateCall={callInitData || undefined}
      />
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
  headerInfo: {
    flex: 1,
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacingX._15,
  },
  headerIconButton: {
    padding: spacingY._5,
  },
  statusText: {
    opacity: 0.8,
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
  typingContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacingX._7,
    marginTop: spacingY._5,
  },
  typingDots: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  typingDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.white,
    opacity: 0.7,
  },
  typingDot1: {
    animationDelay: '0ms',
  },
  typingDot2: {
    animationDelay: '200ms',
  },
  typingDot3: {
    animationDelay: '400ms',
  },
  typingText: {
    fontStyle: 'italic',
  },
  typingBubbleContainer: {
    flexDirection: "row",
    alignItems: "flex-end",
    marginVertical: spacingY._5,
    paddingHorizontal: spacingX._15,
    gap: spacingX._7,
  },
  typingAvatar: {
    marginBottom: spacingY._5,
  },
  typingBubble: {
    backgroundColor: colors.white,
    borderRadius: radius._20,
    paddingHorizontal: spacingX._15,
    paddingVertical: spacingY._12,
    borderBottomLeftRadius: spacingX._5,
    minWidth: 60,
    alignItems: "center",
    justifyContent: "center",
  },
  typingDotsMessage: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  typingDotMessage: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.timestampText,
  },
  emptyStateContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: spacingX._20,
    paddingVertical: spacingY._40,
  },
  emptyStateContent: {
    alignItems: "center",
    gap: spacingY._15,
  },
  emptyStateIcon: {
    marginBottom: spacingY._10,
  },
  emptyStateText: {
    textAlign: "center",
    fontWeight: "600",
  },
  emptyStateSubtext: {
    textAlign: "center",
    opacity: 0.8,
  },
});
