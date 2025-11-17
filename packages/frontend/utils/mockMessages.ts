/**
 * Mock messages data for conversations
 * In production, this would come from your API/store
 */

interface Message {
  id: string;
  text: string;
  senderId: string;
  senderName?: string;
  timestamp: Date;
  isSent: boolean;
}

/**
 * Get mock messages for a conversation
 * Messages are keyed by conversation ID
 */
export function getMockMessages(conversationId: string | null | undefined): Message[] {
  if (!conversationId) return [];

  const now = Date.now();
  const messagesByConversation: Record<string, Message[]> = {
    // Direct conversation 1 - Sarah Chen
    '1': [
      {
        id: 'm1-1',
        text: 'Hey! Are we still on for lunch today?',
        senderId: '1',
        senderName: 'Sarah',
        timestamp: new Date(now - 2 * 60 * 1000),
        isSent: false,
      },
      {
        id: 'm1-2',
        text: 'Yes, absolutely! I was just about to text you 😊',
        senderId: 'current-user',
        timestamp: new Date(now - 1 * 60 * 1000),
        isSent: true,
      },
      {
        id: 'm1-3',
        text: 'Perfect! See you at the usual place at 12:30',
        senderId: '1',
        senderName: 'Sarah',
        timestamp: new Date(now - 30 * 1000),
        isSent: false,
      },
    ],

    // Direct conversation 2 - Michael Rodriguez
    '2': [
      {
        id: 'm2-1',
        text: 'Thanks for the help with the project! Couldn\'t have done it without you.',
        senderId: '2',
        senderName: 'Michael',
        timestamp: new Date(now - 15 * 60 * 1000),
        isSent: false,
      },
      {
        id: 'm2-2',
        text: 'Happy to help! Anytime 👍',
        senderId: 'current-user',
        timestamp: new Date(now - 10 * 60 * 1000),
        isSent: true,
      },
    ],

    // Direct conversation 3 - Emily Watson
    '3': [
      {
        id: 'm3-1',
        text: 'See you at the meeting tomorrow! Don\'t forget to bring the presentation.',
        senderId: '3',
        senderName: 'Emily',
        timestamp: new Date(now - 60 * 60 * 1000),
        isSent: false,
      },
      {
        id: 'm3-2',
        text: 'Will do! Already have it ready 📊',
        senderId: 'current-user',
        timestamp: new Date(now - 55 * 60 * 1000),
        isSent: true,
      },
    ],

    // Direct conversation 4 - David Kim
    '4': [
      {
        id: 'm4-1',
        text: 'The code review looks good to me 👍',
        senderId: '4',
        senderName: 'David',
        timestamp: new Date(now - 3 * 60 * 60 * 1000),
        isSent: false,
      },
      {
        id: 'm4-2',
        text: 'Thanks for reviewing it so quickly!',
        senderId: 'current-user',
        timestamp: new Date(now - 2 * 60 * 60 * 1000),
        isSent: true,
      },
    ],

    // Group conversation 5 - Design Team
    '5': [
      {
        id: 'm5-1',
        text: 'Good morning team! Quick update on the new design system.',
        senderId: '6',
        senderName: 'Jessica',
        timestamp: new Date(now - 10 * 60 * 1000),
        isSent: false,
      },
      {
        id: 'm5-2',
        text: 'Can everyone review the new mockups I shared?',
        senderId: '6',
        senderName: 'Jessica',
        timestamp: new Date(now - 5 * 60 * 1000),
        isSent: false,
      },
      {
        id: 'm5-3',
        text: 'Looking great Jessica! I especially like the color palette.',
        senderId: '7',
        senderName: 'Ryan',
        timestamp: new Date(now - 3 * 60 * 1000),
        isSent: false,
      },
      {
        id: 'm5-4',
        text: 'Agreed! The typography choices are spot on too.',
        senderId: 'current-user',
        timestamp: new Date(now - 2 * 60 * 1000),
        isSent: true,
      },
    ],

    // Group conversation 6 - Weekend Plans
    '6': [
      {
        id: 'm6-1',
        text: 'Who\'s up for a hike this Saturday?',
        senderId: '11',
        senderName: 'Tom',
        timestamp: new Date(now - 2 * 60 * 60 * 1000),
        isSent: false,
      },
      {
        id: 'm6-2',
        text: 'Count me in! What time are we thinking?',
        senderId: 'current-user',
        timestamp: new Date(now - 1.5 * 60 * 60 * 1000),
        isSent: true,
      },
      {
        id: 'm6-3',
        text: 'Count me in for the hike!',
        senderId: '10',
        senderName: 'Lisa',
        timestamp: new Date(now - 1 * 60 * 60 * 1000),
        isSent: false,
      },
      {
        id: 'm6-4',
        text: 'How about 8am? We can hit the trail before it gets too hot.',
        senderId: '11',
        senderName: 'Tom',
        timestamp: new Date(now - 55 * 60 * 1000),
        isSent: false,
      },
    ],

    // Group conversation 7 - Family Group
    '7': [
      {
        id: 'm7-1',
        text: 'Don\'t forget about dinner this Sunday!',
        senderId: '13',
        senderName: 'Mom',
        timestamp: new Date(now - 2 * 60 * 60 * 1000),
        isSent: false,
      },
      {
        id: 'm7-2',
        text: 'What time should we be there?',
        senderId: '15',
        senderName: 'Emma',
        timestamp: new Date(now - 1.5 * 60 * 60 * 1000),
        isSent: false,
      },
      {
        id: 'm7-3',
        text: '6pm sharp! And please bring that dessert you made last time 😊',
        senderId: '13',
        senderName: 'Mom',
        timestamp: new Date(now - 1 * 60 * 60 * 1000),
        isSent: false,
      },
      {
        id: 'm7-4',
        text: 'Will do! Can\'t wait to see everyone.',
        senderId: 'current-user',
        timestamp: new Date(now - 45 * 60 * 1000),
        isSent: true,
      },
    ],

    // Group conversation 8 - Project Alpha
    '8': [
      {
        id: 'm8-1',
        text: 'Let\'s schedule a sync meeting for next week.',
        senderId: '17',
        senderName: 'Daniel',
        timestamp: new Date(now - 4 * 60 * 60 * 1000),
        isSent: false,
      },
      {
        id: 'm8-2',
        text: 'I\'m free Tuesday and Wednesday afternoon.',
        senderId: '18',
        senderName: 'Olivia',
        timestamp: new Date(now - 3.5 * 60 * 60 * 1000),
        isSent: false,
      },
      {
        id: 'm8-3',
        text: 'Tuesday works for me!',
        senderId: 'current-user',
        timestamp: new Date(now - 3 * 60 * 60 * 1000),
        isSent: true,
      },
    ],

    // Direct conversation 9 - Priya Sharma
    '9': [
      {
        id: 'm9-1',
        text: 'Perfect! Looking forward to it 🎉',
        senderId: '9',
        senderName: 'Priya',
        timestamp: new Date(now - 6 * 60 * 60 * 1000),
        isSent: false,
      },
    ],

    // Group conversation 10 - Book Club
    '10': [
      {
        id: 'm10-1',
        text: 'Next month we\'re reading "The Seven Husbands of Evelyn Hugo"',
        senderId: '19',
        senderName: 'Maria',
        timestamp: new Date(now - 24 * 60 * 60 * 1000),
        isSent: false,
      },
      {
        id: 'm10-2',
        text: 'I\'ve been wanting to read that! Excited for the discussion.',
        senderId: '20',
        senderName: 'Kevin',
        timestamp: new Date(now - 23 * 60 * 60 * 1000),
        isSent: false,
      },
      {
        id: 'm10-3',
        text: 'Same here! Should we start reading this week?',
        senderId: 'current-user',
        timestamp: new Date(now - 22 * 60 * 60 * 1000),
        isSent: true,
      },
    ],
  };

  return messagesByConversation[conversationId] || [];
}

