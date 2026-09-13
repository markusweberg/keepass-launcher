// Settings for Mozilla's web-ext tool (npm run lint / build / sign / start).
// Signing reads the AMO API credentials from WEB_EXT_API_KEY and WEB_EXT_API_SECRET.
export default {
  sourceDir: 'extension',
  artifactsDir: 'web-ext-artifacts',
  build: {
    overwriteDest: true,
  },
  sign: {
    channel: 'unlisted',
  },
};
