// Ad-hoc sign the app so it runs on Apple Silicon without a paid Developer ID.
const { execSync } = require('child_process');
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
};
