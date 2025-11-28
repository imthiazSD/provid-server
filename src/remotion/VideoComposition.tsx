import { Layer } from '../types';
import React from 'react';
import {
  AbsoluteFill,
  OffthreadVideo,
  Sequence,
  useVideoConfig,
  useCurrentFrame,
  interpolate,
} from 'remotion';
import { BlurEffect } from './BlurEffect';
import { HighlightEffect } from './HighlightEffect';

interface VideoWithEffectsProps {
  videoUrl: string | null;
  compositionSettings: { layers: Layer[] };
}

export const VideoComposition: React.FC<VideoWithEffectsProps> = ({
  videoUrl,
  compositionSettings,
}) => {
  const { fps, width, height } = useVideoConfig();
  const frame = useCurrentFrame();
  const { layers } = compositionSettings;

  const sortedLayers = [...layers].sort((a, b) => a.start - b.start);

  // Calculate zoom transformation for current frame
  const getZoomTransform = () => {
    const activeZoomLayer = sortedLayers.find(layer => {
      if (layer.type !== 'zoom') return false;

      const layerStartFrame = Math.floor(layer.start * fps);
      const layerEndFrame =
        layerStartFrame +
        Math.ceil((layer.introDuration + layer.mainDuration + layer.outroDuration) * fps);

      return frame >= layerStartFrame && frame < layerEndFrame;
    });

    if (!activeZoomLayer) {
      return { scale: 1, translateX: 0, translateY: 0 };
    }

    const layerStartFrame = Math.floor(activeZoomLayer.start * fps);
    const localFrame = frame - layerStartFrame;

    const introEndFrame = activeZoomLayer.introDuration * fps;
    const mainEndFrame = introEndFrame + activeZoomLayer.mainDuration * fps;
    const outroEndFrame = mainEndFrame + activeZoomLayer.outroDuration * fps;

    const easeInOutCubic = (t: number) =>
      t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

    let easedProgress = 0;
    if (localFrame <= introEndFrame) {
      easedProgress = easeInOutCubic(
        interpolate(localFrame, [0, introEndFrame], [0, 1], {
          extrapolateRight: 'clamp',
        })
      );
    } else if (localFrame <= mainEndFrame) {
      easedProgress = 1;
    } else if (localFrame <= outroEndFrame) {
      easedProgress = easeInOutCubic(
        interpolate(localFrame, [mainEndFrame, outroEndFrame], [1, 0], {
          extrapolateRight: 'clamp',
        })
      );
    }

    const scale = interpolate(easedProgress, [0, 1], [1, activeZoomLayer.data.zoomFactor || 1.5]);

    const layerCenterX = activeZoomLayer.data.x + activeZoomLayer.data.width / 2;
    const layerCenterY = activeZoomLayer.data.y + activeZoomLayer.data.height / 2;

    let translateX = -width * layerCenterX * (scale - 1);
    let translateY = -height * layerCenterY * (scale - 1);

    const scaledWidth = width * scale;
    const scaledHeight = height * scale;

    const minTranslateX = Math.min(0, width - scaledWidth);
    const maxTranslateX = 0;
    const minTranslateY = Math.min(0, height - scaledHeight);
    const maxTranslateY = 0;

    translateX = Math.min(maxTranslateX, Math.max(minTranslateX, translateX));
    translateY = Math.min(maxTranslateY, Math.max(minTranslateY, translateY));

    return { scale, translateX, translateY };
  };

  const zoomTransform = getZoomTransform();

  return (
    <AbsoluteFill>
      {videoUrl && (
        <AbsoluteFill style={{ overflow: 'hidden' }}>
          <AbsoluteFill
            style={{
              transform: `translate(${zoomTransform.translateX}px, ${zoomTransform.translateY}px) scale(${zoomTransform.scale})`,
              transformOrigin: 'top left',
              willChange: 'transform',
            }}
          >
            <OffthreadVideo src={videoUrl} />
            {sortedLayers
              .filter(layer => layer.type === 'blur')
              .map(layer => (
                <Sequence
                  key={layer.id}
                  from={Math.floor(layer.start * fps)}
                  durationInFrames={Math.ceil(
                    (layer.introDuration + layer.mainDuration + layer.outroDuration) * fps
                  )}
                >
                  <BlurEffect layer={layer} />
                </Sequence>
              ))}
          </AbsoluteFill>
        </AbsoluteFill>
      )}
      {sortedLayers
        .filter(layer => layer.type === 'highlight')
        .map(layer => (
          <Sequence
            from={Math.floor(layer.start * fps)}
            durationInFrames={Math.ceil(
              (layer.introDuration + layer.mainDuration + layer.outroDuration) * fps
            )}
            key={layer.id}
          >
            <HighlightEffect layer={layer} />
          </Sequence>
        ))}
    </AbsoluteFill>
  );
};
