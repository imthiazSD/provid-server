import { registerRoot } from 'remotion';
import { Composition } from 'remotion';
import { VideoComposition } from './VideoComposition';

// Register all your compositions here
export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="MainComposition"
        component={VideoComposition}
        durationInFrames={300} // 10 seconds at 30fps
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          videoUrl: '',
          compositionSettings: {},
        }}
      />
    </>
  );
};

registerRoot(RemotionRoot);
