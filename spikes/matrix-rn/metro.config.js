// Configuración por defecto de Expo. El spike vive fuera de los workspaces de
// Allo y tiene su propio node_modules, así que no hace falta `watchFolders` ni
// `extraNodeModules`.
const { getDefaultConfig } = require('expo/metro-config');

module.exports = getDefaultConfig(__dirname);
