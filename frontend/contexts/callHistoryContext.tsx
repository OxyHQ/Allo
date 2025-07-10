import React, { createContext, useContext, useState, useCallback } from 'react';

interface CallHistoryItem {
    id: string;
    conversationId: string;
    conversationName: string;
    conversationAvatar?: string;
    callType: 'audio' | 'video';
    status: 'missed' | 'incoming' | 'outgoing';
    duration?: string;
    timestamp: string;
    participants: string[];
    isDirect: boolean;
}

interface CallHistoryContextType {
    callHistory: CallHistoryItem[];
    addCallToHistory: (call: Omit<CallHistoryItem, 'id'>) => void;
    updateCallDuration: (callId: string, duration: string) => void;
    clearCallHistory: () => void;
    getCallsForConversation: (conversationId: string) => CallHistoryItem[];
}

const CallHistoryContext = createContext<CallHistoryContextType | undefined>(undefined);

export const useCallHistory = () => {
    const context = useContext(CallHistoryContext);
    if (!context) {
        throw new Error('useCallHistory must be used within a CallHistoryProvider');
    }
    return context;
};

export const CallHistoryProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [callHistory, setCallHistory] = useState<CallHistoryItem[]>([]);

    const addCallToHistory = useCallback((call: Omit<CallHistoryItem, 'id'>) => {
        const newCall: CallHistoryItem = {
            ...call,
            id: `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        };

        setCallHistory(prev => [newCall, ...prev]);
    }, []);

    const updateCallDuration = useCallback((callId: string, duration: string) => {
        setCallHistory(prev =>
            prev.map(call =>
                call.id === callId
                    ? { ...call, duration }
                    : call
            )
        );
    }, []);

    const clearCallHistory = useCallback(() => {
        setCallHistory([]);
    }, []);

    const getCallsForConversation = useCallback((conversationId: string) => {
        return callHistory.filter(call => call.conversationId === conversationId);
    }, [callHistory]);

    const value: CallHistoryContextType = {
        callHistory,
        addCallToHistory,
        updateCallDuration,
        clearCallHistory,
        getCallsForConversation,
    };

    return (
        <CallHistoryContext.Provider value={value}>
            {children}
        </CallHistoryContext.Provider>
    );
}; 