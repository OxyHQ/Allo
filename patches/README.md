# Patches

## react-native-css 3.1.0-rc.0

On native, NativeWind's Metro resolver sends every `import … from 'react-native'`
outside React Native itself to `react-native-css/components`, a shim that
re-exports a fixed list of React Native APIs. React Native 0.88 added
`AssetRegistry` to its index and Expo SDK 58's `expo-asset` imports it from
there; the shim does not list it, so every `useFonts` failed with `Cannot read
property 'getAssetByID' of undefined`, Bloom's font gate never opened, and the
Android release build showed a grey window with no JS error. Same patch as
Mention's (OxyHQ/Mention#1607). Delete it once the app takes the fix from
`@oxy.so/app-preset/metro` or upstream re-exports `AssetRegistry`.
