const { withGradleProperties } = require('expo/config-plugins');

/**
 * Restringe el APK a las ABIs para las que @unomed/react-native-matrix-sdk trae
 * librería nativa.
 *
 * El paquete envía `libmatrix_sdk_ffi.so` precompilada solo para `arm64-v8a` y
 * `armeabi-v7a` (`android/src/main/jniLibs/`). La plantilla de Expo pone
 * `reactNativeArchitectures=armeabi-v7a,arm64-v8a,x86,x86_64`, así que por
 * defecto se generan además slices x86 y x86_64 SIN esa librería dentro.
 *
 * Eso no falla al compilar: falla al arrancar, en el dispositivo, con un
 * UnsatisfiedLinkError que no menciona ni a Expo ni a las ABIs. Y como efecto
 * secundario descarta el emulador x86_64 como forma de probar esto — hace falta
 * hardware ARM real o un emulador arm64.
 *
 * Se fijan las dos ABIs que el módulo soporta, no solo arm64: es exactamente lo
 * que la dependencia ofrece, y así un Android de 32 bits sigue funcionando.
 */
const SUPPORTED_ABIS = 'armeabi-v7a,arm64-v8a';
const PROPERTY = 'reactNativeArchitectures';

module.exports = function withMatrixSdkAbis(config) {
  return withGradleProperties(config, (gradleConfig) => {
    const existing = gradleConfig.modResults.find(
      (item) => item.type === 'property' && item.key === PROPERTY
    );

    if (existing) {
      existing.value = SUPPORTED_ABIS;
    } else {
      gradleConfig.modResults.push({
        type: 'property',
        key: PROPERTY,
        value: SUPPORTED_ABIS,
      });
    }

    return gradleConfig;
  });
};
