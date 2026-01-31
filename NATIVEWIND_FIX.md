# NativeWind Fix for Expo 54

## 🐛 Issue
NativeWind v4 was not working on iOS/Android (native platforms) - styles only working on web.

## ✅ Root Cause
The **Metro bundler** was missing NativeWind CSS configuration. Without it, Metro doesn't process the `global.css` file on native platforms.

## 🔧 Fix Applied

### Changed File: `metro.config.js`

**Before** (broken on native):
```javascript
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

module.exports = config;
```

**After** (works on all platforms):
```javascript
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

const config = getDefaultConfig(__dirname);

// Enable NativeWind CSS support for native platforms
module.exports = withNativeWind(config, { input: './styles/global.css' });
```

## 📋 Configuration Checklist

All NativeWind v4 requirements are now met:

### 1. ✅ Tailwind Config (`tailwind.config.js`)
```javascript
module.exports = {
  content: ['./app/**/*.{js,ts,tsx}', './components/**/*.{js,ts,tsx}'],
  presets: [require("nativewind/preset")], // ✓ Correct
  // ...
}
```

### 2. ✅ Babel Config (`babel.config.js`)
```javascript
presets: [
  [
    'babel-preset-expo',
    {
      jsxImportSource: "nativewind", // ✓ Correct
    },
  ],
  'nativewind/babel', // ✓ Correct
],
```

### 3. ✅ Metro Config (`metro.config.js`)
```javascript
const { withNativeWind } = require('nativewind/metro');
module.exports = withNativeWind(config, { input: './styles/global.css' }); // ✓ FIXED
```

### 4. ✅ Global CSS (`styles/global.css`)
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

### 5. ✅ Import in Layout (`app/_layout.tsx`)
```typescript
import '../styles/global.css'; // ✓ Correct
```

## 🚀 Next Steps

### 1. **Restart the Metro bundler**
```bash
# Stop the current dev server (Ctrl+C)
# Clear cache and restart
npm run start
# Or with Expo CLI
expo start --clear
```

### 2. **Rebuild native apps** (if already built)
```bash
# iOS
npm run ios

# Android
npm run android
```

### 3. **Test on all platforms**
```bash
# Web (should still work)
npm run web

# iOS (should now work)
npm run ios

# Android (should now work)
npm run android
```

## ✅ Verification

After restarting, NativeWind should work on all platforms:

### Test Component
```tsx
import { View, Text } from 'react-native';

export default function TestScreen() {
  return (
    <View className="flex-1 items-center justify-center bg-primary">
      <Text className="text-white text-2xl font-bold">
        NativeWind is working! 🎉
      </Text>
    </View>
  );
}
```

**Expected Result**:
- ✅ **Web**: Green background, white text, centered
- ✅ **iOS**: Green background, white text, centered
- ✅ **Android**: Green background, white text, centered

## 🔍 Why This Happened

NativeWind v4 introduced a new architecture that requires Metro to process CSS files. The `withNativeWind()` wrapper:

1. **Configures Metro resolver** to handle `.css` files
2. **Adds CSS transformer** to convert Tailwind → React Native styles
3. **Sets up proper asset loading** for native platforms

Without it:
- ❌ Metro ignores `global.css` on native
- ❌ Tailwind classes don't get converted
- ❌ Styles appear as plain strings (e.g., `className="bg-red-500"` does nothing)

With it:
- ✅ Metro processes CSS on all platforms
- ✅ Tailwind → StyleSheet conversion happens
- ✅ Classes work identically on web/iOS/Android

## 📚 References

- [NativeWind v4 Metro Setup](https://www.nativewind.dev/v4/getting-started/metro)
- [Expo Metro Config](https://docs.expo.dev/guides/customizing-metro/)
- [NativeWind v4 Migration Guide](https://www.nativewind.dev/v4/getting-started/migration)

## 🎉 Status

✅ **NativeWind is now fully configured for Expo 54**

All platforms (web, iOS, Android) will use the same Tailwind classes consistently after restarting Metro.
