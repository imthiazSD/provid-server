import { Composition, registerRoot } from 'remotion';
import { z } from 'zod';
import { VideoComposition } from './VideoComposition';

// Input props validation
const PropsSchema = z.object({
  videoUrl: z.string().url(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  compositionSettings: z.any(),
});

export type MyProps = z.infer<typeof PropsSchema>;

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="MainComposition"
        component={VideoComposition}
        width={1920}
        height={1080}
        fps={30}
        durationInFrames={300} // Will be overridden dynamically
        defaultProps={{
          videoUrl:
            'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
          durationInSeconds: 60,
          fps: 30,
          compositionSettings: { layers: [] },
        }}
        // This is the correct way
        calculateMetadata={async ({ props }) => {
          const validated = PropsSchema.parse(props);

          const durationInFrames = Math.round(
            validated.compositionSettings.duration * validated.compositionSettings.fps
          );

          return {
            durationInFrames,
            fps: validated.fps,
            props: validated,
          };
        }}
      />
    </>
  );
};

registerRoot(RemotionRoot);
