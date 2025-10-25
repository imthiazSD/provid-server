import React from 'react';
import {
  AbsoluteFill,
  Audio,
  interpolate,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
  Video,
  Img,
  staticFile
} from 'remotion';

interface VideoCompositionProps {
  videoUrl: string;
  compositionSettings: {
    title?: string;
    subtitle?: string;
    overlayText?: string;
    backgroundColor?: string;
    textColor?: string;
    logoUrl?: string;
    audioUrl?: string;
    effects?: {
      fadeIn?: boolean;
      fadeOut?: boolean;
      zoom?: boolean;
    };
  };
}

export const VideoComposition: React.FC<VideoCompositionProps> = ({
  videoUrl,
  compositionSettings
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width, height } = useVideoConfig();

  const {
    title,
    subtitle,
    overlayText,
    backgroundColor = '#000000',
    textColor = '#FFFFFF',
    logoUrl,
    audioUrl,
    effects = {}
  } = compositionSettings;

  // Fade in effect (first 30 frames / 1 second)
  const fadeIn = effects.fadeIn
    ? interpolate(frame, [0, 30], [0, 1], {
        extrapolateRight: 'clamp'
      })
    : 1;

  // Fade out effect (last 30 frames / 1 second)
  const fadeOut = effects.fadeOut
    ? interpolate(frame, [durationInFrames - 30, durationInFrames], [1, 0], {
        extrapolateLeft: 'clamp'
      })
    : 1;

  const opacity = Math.min(fadeIn, fadeOut);

  // Zoom effect
  const scale = effects.zoom
    ? interpolate(frame, [0, durationInFrames], [1, 1.2], {
        extrapolateRight: 'clamp'
      })
    : 1;

  return (
    <AbsoluteFill style={{ backgroundColor }}>
      {/* Main Video */}
      <AbsoluteFill
        style={{
          opacity,
          transform: `scale(${scale})`
        }}
      >
        <Video
          src={videoUrl}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover'
          }}
        />
      </AbsoluteFill>

      {/* Audio Track (if provided) */}
      {audioUrl && <Audio src={audioUrl} />}

      {/* Logo Overlay */}
      {logoUrl && (
        <AbsoluteFill
          style={{
            justifyContent: 'flex-start',
            alignItems: 'flex-end',
            padding: 40
          }}
        >
          <Img
            src={logoUrl}
            style={{
              width: 150,
              height: 'auto',
              opacity: 0.8
            }}
          />
        </AbsoluteFill>
      )}

      {/* Title Sequence (first 3 seconds) */}
      {title && (
        <Sequence from={0} durationInFrames={90}>
          <AbsoluteFill
            style={{
              justifyContent: 'center',
              alignItems: 'center',
              backgroundColor: 'rgba(0, 0, 0, 0.5)'
            }}
          >
            <div
              style={{
                fontSize: 80,
                fontWeight: 'bold',
                color: textColor,
                textAlign: 'center',
                padding: 40,
                fontFamily: 'Arial, sans-serif',
                opacity: interpolate(frame, [0, 15, 75, 90], [0, 1, 1, 0])
              }}
            >
              {title}
            </div>
            {subtitle && (
              <div
                style={{
                  fontSize: 40,
                  color: textColor,
                  textAlign: 'center',
                  marginTop: 20,
                  fontFamily: 'Arial, sans-serif',
                  opacity: interpolate(frame, [15, 30, 75, 90], [0, 1, 1, 0])
                }}
              >
                {subtitle}
              </div>
            )}
          </AbsoluteFill>
        </Sequence>
      )}

      {/* Persistent Overlay Text */}
      {overlayText && (
        <AbsoluteFill
          style={{
            justifyContent: 'flex-end',
            alignItems: 'center',
            padding: 60
          }}
        >
          <div
            style={{
              fontSize: 32,
              color: textColor,
              backgroundColor: 'rgba(0, 0, 0, 0.7)',
              padding: '15px 30px',
              borderRadius: 10,
              fontFamily: 'Arial, sans-serif'
            }}
          >
            {overlayText}
          </div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};