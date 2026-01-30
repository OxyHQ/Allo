function lightenColor(hex: string, percent: number): string {
    const num = parseInt(hex.slice(1), 16);
    const amt = Math.round(2.55 * percent);
    const R = (num >> 16) + amt;
    const G = (num >> 8 & 0x00FF) + amt;
    const B = (num & 0x0000FF) + amt;
    return `#${(0x1000000 + (R < 255 ? R < 1 ? 0 : R : 255) * 0x10000 + (G < 255 ? G < 1 ? 0 : G : 255) * 0x100 + (B < 255 ? B < 1 ? 0 : B : 255)).toString(16).slice(1).toUpperCase()}`;
}

// Updated primary color for better contrast and modern feel
const primaryColor = '#21C063';
const secondaryColor = '#d169e5'; // Oxy brand color

export const colors = {
  primaryColor,
  secondaryColor,
  secondaryLight: '#f3e8ff',
  primaryLight: '#ffffff',
  primaryLight_1: '#DDF3F5',
  primaryLight_2: '#E5F0FF',
  primaryDark: '#000000', // Pure black background (WhatsApp/Telegram style)
  primaryDark_1: '#0A0A0A', // Darker secondary background
  primaryDark_2: '#1A1A1A', // Darker tertiary background
  overlay: 'rgba(0, 0, 0, 0.7)', // Darker overlay
  shadow: 'rgba(0, 0, 0, 0.3)', // Stronger shadow for dark mode
  COLOR_BLACK: '#000',
  COLOR_BLACK_LIGHT_1: '#0F0F0F', // Darker
  COLOR_BLACK_LIGHT_2: '#1A1A1A', // Darker
  COLOR_BLACK_LIGHT_3: '#2A2A2A', // Darker
  COLOR_BLACK_LIGHT_4: '#707070', // Slightly brighter for better contrast
  COLOR_BLACK_LIGHT_5: '#A0A0A0', // Brighter for better text visibility
  COLOR_BLACK_LIGHT_6: '#E8E8E8', // Slightly less bright
  COLOR_BLACK_LIGHT_7: '#F5F5F5',
  COLOR_BLACK_LIGHT_8: '#FAFAFA',
  COLOR_BLACK_LIGHT_9: '#FDFDFD',
  COLOR_BACKGROUND: lightenColor(primaryColor, 90),
    
    // New modern messaging colors
    messageBubbleSent: primaryColor,
    messageBubbleReceived: '#EDF2F7',
    messageTextSent: '#FFFFFF',
    messageTextReceived: '#1A202C',
    messageTimestamp: '#A0AEC0',
    messageSeparator: '#CBD5E0',
    
    // Chat UI specific colors
    chatInputBackground: '#F7FAFC',
    chatInputBorder: '#E2E8F0',
    chatInputText: '#2D3748',
    chatInputPlaceholder: '#A0AEC0',
    chatHeaderBorder: '#E2E8F0',
    chatUnreadBadge: '#FF3B30',
    chatTypingIndicator: '#00C853',
    
    // Interactive elements
    buttonPrimary: primaryColor,
    buttonSecondary: '#718096',
    buttonDisabled: '#CBD5E0',
    linkColor: primaryColor,
    
    // Status colors
    online: '#00C853',
    offline: '#718096',
    busy: '#FF3B30',
    away: '#FFCC00',
} as const;