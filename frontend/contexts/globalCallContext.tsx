import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
import { Alert, Vibration } from 'react-native';
import { useAuth } from '@/contexts/authContext';
import { useCallHistory } from '@/contexts/callHistoryContext';
import { incomingCall, callInitiated, callAnswered, callEnded, webrtcSignal } from '@/socket/socketEvents';

interface CallData {
    callId: string;
    conversationId: string;
    callType: 'audio' | 'video';
    callerId: string;
    callerName: string;
    timestamp: string;
    conversationName?: string;
    conversationAvatar?: string;
    isDirect?: boolean;
    participants?: string[];
}

interface GlobalCallContextType {
    currentCall: CallData | null;
    isCallManagerVisible: boolean;
    showCallManager: (callData: CallData) => void;
    hideCallManager: () => void;
    initializeCallManager: (conversationId: string, conversationName: string, conversationAvatar: string, isDirect: boolean, participants: string[]) => void;
}

const GlobalCallContext = createContext<GlobalCallContextType | undefined>(undefined);

export const useGlobalCall = () => {
    const context = useContext(GlobalCallContext);
    if (!context) {
        throw new Error('useGlobalCall must be used within a GlobalCallProvider');
    }
    return context;
};

export const GlobalCallProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { user: currentUser } = useAuth();
    const { addCallToHistory } = useCallHistory();
    const [currentCall, setCurrentCall] = useState<CallData | null>(null);
    const [isCallManagerVisible, setIsCallManagerVisible] = useState(false);
    const vibrationRef = useRef<NodeJS.Timeout | null>(null);

    // Handle incoming calls globally
    useEffect(() => {
        const handleIncomingCall = (data: any) => {
            console.log('Global incoming call received:', data);

            // Create call data
            const callData: CallData = {
                callId: data.callId,
                conversationId: data.conversationId,
                callType: data.callType,
                callerId: data.callerId,
                callerName: data.callerName,
                timestamp: data.timestamp,
                conversationName: data.callerName, // Will be updated when we have conversation details
                conversationAvatar: '', // Will be updated when we have conversation details
                isDirect: true, // Default to direct, will be updated
                participants: [data.callerId, currentUser?.id || ''],
            };

            // Set current call
            setCurrentCall(callData);

            // Add to call history
            addCallToHistory({
                conversationId: data.conversationId,
                conversationName: data.callerName,
                conversationAvatar: '',
                callType: data.callType,
                status: 'incoming',
                timestamp: data.timestamp,
                participants: [data.callerId, currentUser?.id || ''],
                isDirect: true,
            });

            // Show call manager
            setIsCallManagerVisible(true);

            // Start vibration pattern for incoming call
            const vibrationPattern = [0, 1000, 500, 1000, 500, 1000];
            Vibration.vibrate(vibrationPattern, true);
        };

        const handleCallEnded = (data: any) => {
            console.log('Global call ended:', data);

            // Stop vibration
            Vibration.cancel();

            // Clear current call
            setCurrentCall(null);

            // Hide call manager
            setIsCallManagerVisible(false);
        };

        const handleCallAnswered = (data: any) => {
            console.log('Global call answered:', data);

            // Stop vibration
            Vibration.cancel();

            if (data.answer === 'decline') {
                // Clear current call if declined
                setCurrentCall(null);
                setIsCallManagerVisible(false);
            }
        };

        // Register global socket event handlers
        incomingCall(handleIncomingCall);
        callEnded(handleCallEnded);
        callAnswered(handleCallAnswered);

        return () => {
            // Cleanup socket events
            incomingCall(handleIncomingCall, true);
            callEnded(handleCallEnded, true);
            callAnswered(handleCallAnswered, true);

            // Stop any ongoing vibration
            Vibration.cancel();
        };
    }, [currentUser?.id, addCallToHistory]);

    const showCallManager = (callData: CallData) => {
        setCurrentCall(callData);
        setIsCallManagerVisible(true);
    };

    const hideCallManager = () => {
        setCurrentCall(null);
        setIsCallManagerVisible(false);
        Vibration.cancel();
    };

    const initializeCallManager = (
        conversationId: string,
        conversationName: string,
        conversationAvatar: string,
        isDirect: boolean,
        participants: string[]
    ) => {
        if (currentCall && currentCall.conversationId === conversationId) {
            // Update current call with conversation details
            setCurrentCall(prev => prev ? {
                ...prev,
                conversationName,
                conversationAvatar,
                isDirect,
                participants,
            } : null);
        }
    };

    const value: GlobalCallContextType = {
        currentCall,
        isCallManagerVisible,
        showCallManager,
        hideCallManager,
        initializeCallManager,
    };

    return (
        <GlobalCallContext.Provider value={value}>
            {children}
        </GlobalCallContext.Provider>
    );
}; 