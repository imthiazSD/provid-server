export interface Layer {
  id: string;
  type: 'highlight' | 'zoom' | 'blur';
  start: number;
  introDuration: number;
  mainDuration: number;
  outroDuration: number;
  data: {
    x: number;
    y: number;
    width: number;
    height: number;
    color?: string;
    zoomFactor?: number;
    blurAmount?: number;
    transparency?: number;
  };
}
