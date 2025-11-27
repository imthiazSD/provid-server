// src/Root.tsx
import { parseMedia } from '@remotion/media-parser';
import { Composition, registerRoot } from 'remotion';
import { z } from 'zod';
import { VideoComposition } from './VideoComposition';

// Input props validation
const PropsSchema = z.object({
  videoUrl: z.string().url(),
  compositionSettings: z.object({
    layers: z.array(z.any()), // Replace with proper Layer type later
  }),
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
        // FPS will be determined dynamically (fallback 30)
        fps={30}
        defaultProps={{
          videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
          compositionSettings: { layers: [] },
        }}
        // Dynamically calculate duration & FPS using parseMedia
        calculateMetadata={async ({ props }) => {
          const validated = PropsSchema.parse(props);

          if (!validated.videoUrl) {
            return { durationInFrames: 300, fps: 30 };
          }

          try {
            const result = await parseMedia({
              src: validated.videoUrl,
              fields: {
                durationInSeconds: true,
                dimensions: true,
              },
              // For URLs, no reader needed (it fetches directly)
              // If src is local path, add: reader: nodeReader
            });

            const durationInSeconds = result.durationInSeconds ?? 10; // Fallback
            const finalFps = 30; // Fallback; extend with onVideoTrack if needed for exact FPS

            const videoFrames = Math.ceil(durationInSeconds * finalFps);

            return {
              durationInFrames: videoFrames,
              fps: finalFps,
              props: validated, // Pass validated props
            };
          } catch (error) {
            console.warn('Failed to parse media metadata, using fallback', error);
            return { durationInFrames: 900, fps: 30 }; // 30 sec fallback
          }
        }}
      />
    </>
  );
};

registerRoot(RemotionRoot);