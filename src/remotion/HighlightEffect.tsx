import { hexWithAlphaToRgba } from './utils';
import { Layer } from './types';
import { interpolate, useCurrentFrame, useVideoConfig } from 'remotion';

interface HighlightEffectProps {
  layer: Layer;
}

export const HighlightEffect: React.FC<HighlightEffectProps> = ({ layer }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const startFrame = 0;
  const introEndFrame = layer.introDuration > 0 ? layer.introDuration * fps : startFrame + 1; // Ensure it's at least 1 frame ahead
  const mainEndFrame = introEndFrame + (layer.mainDuration > 0 ? layer.mainDuration * fps : 1); // Ensure it's at least 1 frame ahead
  const outroEndFrame = mainEndFrame + (layer.outroDuration > 0 ? layer.outroDuration * fps : 1); // Ensure it's at least 1 frame ahead

  const opacity = interpolate(
    frame,
    [startFrame, introEndFrame, mainEndFrame, outroEndFrame],
    [0, 1, 1, 0],
    {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    }
  );

  const defaultColor = '#000000';
  const color = hexWithAlphaToRgba(layer.data.color || defaultColor, layer.data.transparency / 100);

  return (
    <div style={{ position: 'absolute', width: '100%', height: '100%' }}>
      {/* Top tinted area */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: `${layer.data.y * 100}%`,
          backgroundColor: color,
          opacity,
        }}
      />
      {/* Left tinted area */}
      <div
        style={{
          position: 'absolute',
          top: `${layer.data.y * 100}%`,
          left: 0,
          width: `${layer.data.x * 100}%`,
          height: `${layer.data.height * 100}%`,
          backgroundColor: color,
          opacity,
        }}
      />
      {/* Right tinted area */}
      <div
        style={{
          position: 'absolute',
          top: `${layer.data.y * 100}%`,
          left: `${(layer.data.x + layer.data.width) * 100}%`,
          width: `${(1 - layer.data.x - layer.data.width) * 100}%`,
          height: `${layer.data.height * 100}%`,
          backgroundColor: color,
          opacity,
        }}
      />
      {/* Bottom tinted area */}
      <div
        style={{
          position: 'absolute',
          top: `${(layer.data.y + layer.data.height) * 100}%`,
          left: 0,
          width: '100%',
          height: `${(1 - layer.data.y - layer.data.height) * 100}%`,
          backgroundColor: color,
          opacity,
        }}
      />
    </div>
  );
};
