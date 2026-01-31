/** @type {import('tailwindcss').Config} */
module.exports = {
    // NOTE: Update this to include the paths to all of your component files.
    content: ['./app/**/*.{js,ts,tsx}', './components/**/*.{js,ts,tsx}'],
    presets: [require("nativewind/preset")],
    theme: {
      extend: {
        colors: {
          // Primary brand colors
          primary: '#21C063',
          'primary-light': '#DDF3F5',
          'primary-light-1': '#DDF3F5',
          'primary-light-2': '#E5F0FF',
          'primary-dark': '#000000',
          'primary-dark-1': '#0A0A0A',
          'primary-dark-2': '#1A1A1A',

          secondary: '#d169e5',
          'secondary-light': '#f3e8ff',

          // Semantic theme colors (light mode defaults)
          'theme-bg': '#FDFDFD',
          'theme-bg-secondary': '#FAFAFA',
          'theme-bg-tertiary': '#F5F5F5',
          'theme-text': '#1A1A1A',
          'theme-text-secondary': '#707070',
          'theme-text-tertiary': '#A0A0A0',
          'theme-border': '#E8E8E8',
          'theme-border-light': '#F5F5F5',
          'theme-card': '#FFFFFF',

          // Grayscale palette
          'black-light-1': '#0F0F0F',
          'black-light-2': '#1A1A1A',
          'black-light-3': '#2A2A2A',
          'black-light-4': '#707070',
          'black-light-5': '#A0A0A0',
          'black-light-6': '#E8E8E8',
          'black-light-7': '#F5F5F5',
          'black-light-8': '#FAFAFA',
          'black-light-9': '#FDFDFD',

          // Message colors (light mode)
          'message-sent': '#21C063',
          'message-received': '#EDF2F7',
          'message-text-sent': '#FFFFFF',
          'message-text-received': '#1A202C',
          'message-timestamp': '#A0AEC0',
          'message-separator': '#CBD5E0',

          // Dark mode message colors
          'message-received-dark': '#1A1A1A',
          'message-text-received-dark': '#E8E8E8',
          'message-timestamp-dark': '#707070',
          'message-separator-dark': '#2A2A2A',

          // Interactive elements
          'button-primary': '#21C063',
          'button-secondary': '#718096',
          'button-disabled': '#CBD5E0',
          link: '#21C063',

          // Status colors
          online: '#00C853',
          offline: '#718096',
          busy: '#FF3B30',
          away: '#FFCC00',

          // Chat UI colors
          'chat-input-bg': '#F7FAFC',
          'chat-input-border': '#E2E8F0',
          'chat-input-text': '#2D3748',
          'chat-input-placeholder': '#A0AEC0',
          'chat-header-border': '#E2E8F0',
          'chat-unread-badge': '#FF3B30',
          'chat-typing': '#00C853',

          // Dark mode chat UI
          'chat-input-bg-dark': '#0A0A0A',
          'chat-input-border-dark': '#2A2A2A',
          'chat-input-text-dark': '#E8E8E8',
          'chat-input-placeholder-dark': '#707070',
          'chat-header-border-dark': '#1A1A1A',

          // Utility colors
          overlay: 'rgba(0, 0, 0, 0.7)',
          shadow: 'rgba(0, 0, 0, 0.3)',
        },
        borderRadius: {
          'message': '20px',
        },
      },
    },
    plugins: [],
  }