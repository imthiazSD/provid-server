import { Config } from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setOverwriteOutput(true);
Config.setPixelFormat('yuv420p');
Config.setConcurrency(2);

// Lambda-specific configuration
Config.setChromiumOpenGlRenderer('angle');
Config.setDelayRenderTimeoutInMilliseconds(30000);
Config.setEntryPoint('./src/remotion/index.tsx');

// Webpack configuration to ensure dependencies are bundled
Config.overrideWebpackConfig(currentConfiguration => {
  return {
    ...currentConfiguration,
    resolve: {
      ...currentConfiguration.resolve,
      // Remove the custom alias and let webpack resolve from node_modules naturally
      modules: [
        'node_modules',
        '../../node_modules', // Parent directory node_modules
        ...(currentConfiguration.resolve?.modules || []),
      ],
    },
  };
});

export default Config;
