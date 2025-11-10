import { Layer } from './types';
import { interpolate, useCurrentFrame, useVideoConfig } from 'remotion';

export const BlurEffect: React.FC<{ layer: Layer }> = ({ layer }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const startFrame = 0;

  const introEndFrame = layer.introDuration > 0 ? layer.introDuration * fps : startFrame + 1; // Ensure it's at least 1 frame ahead
  const mainEndFrame = introEndFrame + (layer.mainDuration > 0 ? layer.mainDuration * fps : 1); // Ensure it's at least 1 frame ahead
  const outroEndFrame = mainEndFrame + (layer.outroDuration > 0 ? layer.outroDuration * fps : 1); // Ensure it's at least 1 frame ahead

  const blurAmount = interpolate(
    frame,
    [startFrame, introEndFrame, mainEndFrame, outroEndFrame],
    [0, layer.data.blurAmount || 10, layer.data.blurAmount || 10, 0],
    {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    }
  );

  return (
    <div
      style={{
        position: 'absolute',
        left: `${layer.data.x * 100}%`,
        top: `${layer.data.y * 100}%`,
        width: `${layer.data.width * 100}%`,
        height: `${layer.data.height * 100}%`,
        backdropFilter: `blur(${blurAmount}px)`,
      }}
    />
  );
};
