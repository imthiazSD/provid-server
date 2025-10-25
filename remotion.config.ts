import { Config } from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setOverwriteOutput(true);
Config.setPixelFormat('yuv420p');
Config.setConcurrency(2);

// Lambda-specific configuration
Config.setChromiumOpenGlRenderer('angle');
Config.setDelayRenderTimeoutInMilliseconds(30000);
Config.setEntryPoint('./src/remotion/index.tsx'); // Changed from .ts to .tsx

export default Config;