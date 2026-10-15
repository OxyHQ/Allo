const { withInfoPlist, withEntitlementsPlist } = require('expo/config-plugins');
module.exports = (config) => {
  config = withInfoPlist(config, (mod) => {
    mod.modResults.UIBackgroundModes = [
      ...new Set([
        ...(mod.modResults.UIBackgroundModes ?? []),
        'voip',
        'audio',
        'remote-notification',
      ]),
    ];
    return mod;
  });
  return withEntitlementsPlist(config, (mod) => {
    // Xcode/EAS adjusts this entitlement to the provisioning profile on export.
    mod.modResults['aps-environment'] ??= 'development';
    return mod;
  });
};
