export type ImageQualityIssue =
  | 'capture_failed'
  | 'too_dark'
  | 'too_bright'
  | 'blurry'
  | 'insufficient_skin_area';

export interface ImageQualityMetrics {
  meanLuminance: number;
  darkPixelRatio: number;
  clippedBrightRatio: number;
  sharpnessScore: number;
  edgeStrength: number;
  centerSkinRatio: number;
  frameStdDev: number;
}

export interface IndividualCheckResult {
  id: 'lighting' | 'brightness' | 'focus' | 'framing';
  label: string;
  status: 'passed' | 'failed' | 'not_performed';
  detail: string;
}

export interface ImageQualityReport {
  checkPerformed: boolean;
  passed: boolean;
  issues: ImageQualityIssue[];
  checks: IndividualCheckResult[];
  metrics: ImageQualityMetrics | null;
  spokenFeedback: string;
}

export interface CapturedPhotoResult {
  dataUrl: string;
  report: ImageQualityReport;
  capturedAt: string;
}

const ANALYSIS_WIDTH = 320;
const ANALYSIS_HEIGHT = 240;

/**
 * Evaluates a rendered video frame using real pixel-level canvas analysis.
 * Checks luminance (too dark / too bright), Laplacian focus sharpness,
 * and inclusive YCbCr skin-area presence in the central framing zone.
 */
export function analyzeImageDataQuality(imageData: ImageData): ImageQualityReport {
  const { data, width, height } = imageData;
  const totalPixels = width * height;

  if (!data || totalPixels === 0) {
    return buildUnperformedReport(
      'Image quality check could not be performed because no pixel data was available.'
    );
  }

  const luminance = new Float32Array(totalPixels);

  let lumSum = 0;
  let lumSqSum = 0;
  let darkCount = 0;
  let brightCount = 0;

  // Central framing window: inner 55% horizontally & vertically
  const roiLeft = Math.floor(width * 0.225);
  const roiRight = Math.ceil(width * 0.775);
  const roiTop = Math.floor(height * 0.225);
  const roiBottom = Math.ceil(height * 0.775);

  let centerPixels = 0;
  let centerSkinPixels = 0;
  let centerLumSum = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x;
      const p = idx * 4;
      const r = data[p];
      const g = data[p + 1];
      const b = data[p + 2];

      const yLum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      luminance[idx] = yLum;

      lumSum += yLum;
      lumSqSum += yLum * yLum;

      if (yLum < 42) darkCount += 1;
      if (yLum > 242 || (r > 250 && g > 250 && b > 250)) brightCount += 1;

      if (x >= roiLeft && x < roiRight && y >= roiTop && y < roiBottom) {
        centerPixels += 1;
        centerLumSum += yLum;

        // Inclusive YCbCr skin-tone chrominance detector covering light through deep skin tones
        const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
        const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;

        const inWarmSkinChroma =
          cb >= 75 && cb <= 136 && cr >= 131 && cr <= 182 && r >= b - 4;
        // Very deep skin under low/cool indoor light can sit near neutral chroma with warm R>=G
        const inDeepWarmSkin =
          yLum >= 20 && yLum <= 110 && r >= g && g >= b - 4 && cr >= 129 && cb >= 85 && cb <= 134;

        if (inWarmSkinChroma || inDeepWarmSkin) {
          centerSkinPixels += 1;
        }
      }
    }
  }

  const meanLuminance = lumSum / totalPixels;
  const variance = Math.max(0, lumSqSum / totalPixels - meanLuminance * meanLuminance);
  const frameStdDev = Math.sqrt(variance);
  const darkPixelRatio = darkCount / totalPixels;
  const clippedBrightRatio = brightCount / totalPixels;
  const centerMeanLum = centerPixels > 0 ? centerLumSum / centerPixels : meanLuminance;
  const centerSkinRatio = centerPixels > 0 ? centerSkinPixels / centerPixels : 0;

  // Compute discrete 4-neighbor Laplacian variance & Sobel-like edge magnitude in center ROI
  let lapSum = 0;
  let lapSqSum = 0;
  let edgeSum = 0;
  let lapCount = 0;

  const startY = Math.max(1, roiTop);
  const endY = Math.min(height - 1, roiBottom);
  const startX = Math.max(1, roiLeft);
  const endX = Math.min(width - 1, roiRight);

  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const i = y * width + x;
      const center = luminance[i];
      const left = luminance[i - 1];
      const right = luminance[i + 1];
      const up = luminance[i - width];
      const down = luminance[i + width];

      const lap = 4 * center - left - right - up - down;
      lapSum += lap;
      lapSqSum += lap * lap;

      const gx = Math.abs(right - left);
      const gy = Math.abs(down - up);
      edgeSum += gx + gy;
      lapCount += 1;
    }
  }

  const lapMean = lapCount > 0 ? lapSum / lapCount : 0;
  const sharpnessScore =
    lapCount > 0 ? Math.max(0, lapSqSum / lapCount - lapMean * lapMean) : 0;
  const edgeStrength = lapCount > 0 ? edgeSum / lapCount : 0;

  // If frame is completely uniform black (e.g. physical camera shutter closed), capture failed/blocked
  if (frameStdDev < 2.2 && meanLuminance < 10) {
    const metrics: ImageQualityMetrics = {
      meanLuminance,
      darkPixelRatio,
      clippedBrightRatio,
      sharpnessScore,
      edgeStrength,
      centerSkinRatio,
      frameStdDev,
    };
    return {
      checkPerformed: true,
      passed: false,
      issues: ['capture_failed', 'too_dark'],
      checks: [
        {
          id: 'lighting',
          label: 'Lighting',
          status: 'failed',
          detail: 'Frame is completely dark or lens appears covered.',
        },
        {
          id: 'brightness',
          label: 'Glare Control',
          status: 'not_performed',
          detail: 'Could not evaluate glare on a black frame.',
        },
        {
          id: 'focus',
          label: 'Focus & Sharpness',
          status: 'not_performed',
          detail: 'Could not evaluate focus on a black frame.',
        },
        {
          id: 'framing',
          label: 'Skin Framing',
          status: 'failed',
          detail: 'No skin area visible; check that your camera lens is uncovered.',
        },
      ],
      metrics,
      spokenFeedback:
        'The captured frame is completely dark. Please make sure your camera lens is uncovered, move to a well-lit area, and say Retake.',
    };
  }

  const isTooDark =
    meanLuminance < 52 || centerMeanLum < 48 || (meanLuminance < 68 && darkPixelRatio > 0.65);
  const isTooBright = meanLuminance > 218 || clippedBrightRatio > 0.32;
  // Detect blurry or heavily out-of-focus frames (low high-frequency Laplacian variance and low edge strength)
  const isBlurry = !isTooDark && !isTooBright && sharpnessScore < 20 && edgeStrength < 7.5;
  const hasInsufficientSkin =
    !isTooDark && (centerSkinRatio < 0.2 || (frameStdDev < 5 && centerSkinRatio < 0.35));

  const issues: ImageQualityIssue[] = [];
  if (isTooDark) issues.push('too_dark');
  if (isTooBright) issues.push('too_bright');
  if (isBlurry) issues.push('blurry');
  if (hasInsufficientSkin) issues.push('insufficient_skin_area');

  const checks: IndividualCheckResult[] = [
    {
      id: 'lighting',
      label: 'Lighting',
      status: isTooDark ? 'failed' : 'passed',
      detail: isTooDark
        ? 'Insufficient light detected.'
        : 'Lighting level is adequate.',
    },
    {
      id: 'brightness',
      label: 'Glare Control',
      status: isTooBright ? 'failed' : 'passed',
      detail: isTooBright
        ? 'Excessive brightness or glare detected.'
        : 'No excessive glare detected.',
    },
    {
      id: 'focus',
      label: 'Focus & Sharpness',
      status: isTooDark || isTooBright ? 'not_performed' : isBlurry ? 'failed' : 'passed',
      detail:
        isTooDark || isTooBright
          ? 'Improve lighting first to verify focus accurately.'
          : isBlurry
            ? 'Image looks soft or blurred.'
            : 'Focus and detail look clear.',
    },
    {
      id: 'framing',
      label: 'Skin Framing',
      status: isTooDark ? 'not_performed' : hasInsufficientSkin ? 'failed' : 'passed',
      detail: isTooDark
        ? 'Improve lighting first to verify skin framing.'
        : hasInsufficientSkin
          ? 'Skin area is not clearly centered in the frame.'
          : 'Skin area detected in the center frame.',
    },
  ];

  const guidanceParts: string[] = [];
  if (isTooDark) {
    guidanceParts.push(
      'The image is too dark. Move near a bright window or indoor lamp so the skin area is evenly lit.'
    );
  }
  if (isTooBright) {
    guidanceParts.push(
      'The image is too bright or washed out by glare. Angle the camera slightly away from direct light.'
    );
  }
  if (isBlurry) {
    guidanceParts.push(
      'The image appears blurry or out of focus. Hold the camera steady about 15 to 20 centimeters—one hand’s length—away from your skin and wait a moment before capturing.'
    );
  }
  if (hasInsufficientSkin) {
    guidanceParts.push(
      'The intended skin area is not clearly visible in the center of the frame. Move slightly closer and aim directly at the skin area.'
    );
  }

  const passed = issues.length === 0;
  const spokenFeedback = passed
    ? 'Image quality check passed. Lighting, focus, and skin framing look clear. Say "Analyze photo" to inspect this image, "Retake" for a new photo, or "Cancel" to discard it.'
    : `${guidanceParts.join(' ')} Please adjust and say Retake, or say Cancel to stop.`;

  return {
    checkPerformed: true,
    passed,
    issues,
    checks,
    metrics: {
      meanLuminance,
      darkPixelRatio,
      clippedBrightRatio,
      sharpnessScore,
      edgeStrength,
      centerSkinRatio,
      frameStdDev,
    },
    spokenFeedback,
  };
}

export function buildUnperformedReport(reason: string): ImageQualityReport {
  return {
    checkPerformed: false,
    passed: false,
    issues: ['capture_failed'],
    checks: [
      {
        id: 'lighting',
        label: 'Lighting',
        status: 'not_performed',
        detail: 'Check was not performed.',
      },
      {
        id: 'brightness',
        label: 'Glare Control',
        status: 'not_performed',
        detail: 'Check was not performed.',
      },
      {
        id: 'focus',
        label: 'Focus & Sharpness',
        status: 'not_performed',
        detail: 'Check was not performed.',
      },
      {
        id: 'framing',
        label: 'Skin Framing',
        status: 'not_performed',
        detail: 'Check was not performed.',
      },
    ],
    metrics: null,
    spokenFeedback: reason,
  };
}

const MAX_CAPTURE_DIMENSION = 1024;
const JPEG_CAPTURE_QUALITY = 0.86;

export function computeScaledDimensions(
  srcWidth: number,
  srcHeight: number,
  maxDimension = MAX_CAPTURE_DIMENSION
): { width: number; height: number; scaled: boolean } {
  if (srcWidth <= 0 || srcHeight <= 0) {
    return { width: 0, height: 0, scaled: false };
  }
  const longest = Math.max(srcWidth, srcHeight);
  if (longest <= maxDimension) {
    return { width: srcWidth, height: srcHeight, scaled: false };
  }
  const ratio = maxDimension / longest;
  return {
    width: Math.max(1, Math.round(srcWidth * ratio)),
    height: Math.max(1, Math.round(srcHeight * ratio)),
    scaled: true,
  };
}

export function optimizeImageElementForObservation(
  img: HTMLImageElement,
  originalDataUrl: string,
  originalMimeType: string,
  originalByteLength: number
): string {
  const { width, height, scaled } = computeScaledDimensions(
    img.naturalWidth || img.width,
    img.naturalHeight || img.height,
    MAX_CAPTURE_DIMENSION
  );

  // Skip redundant recompression if already compact and within target bounds
  const alreadyCompact =
    !scaled &&
    originalByteLength <= 380 * 1024 &&
    (originalMimeType === 'image/jpeg' || originalMimeType === 'image/webp');

  if (alreadyCompact || width === 0 || height === 0) {
    return originalDataUrl;
  }

  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return originalDataUrl;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, width, height);

    const optimized = canvas.toDataURL('image/jpeg', JPEG_CAPTURE_QUALITY);
    // Keep optimized JPEG whenever it resized an oversized photo or meaningfully reduced size
    if (scaled || optimized.length < originalDataUrl.length) {
      return optimized;
    }
    return originalDataUrl;
  } catch {
    return originalDataUrl;
  }
}

/**
 * Captures a still frame from an active <video> element, scales oversized frames
 * down to max 1024px JPEG (preserving skin detail while avoiding bloated payloads),
 * and performs real pixel-level quality checks.
 */
export function captureAndEvaluateVideoFrame(video: HTMLVideoElement | null): {
  dataUrl: string | null;
  report: ImageQualityReport;
} {
  if (
    !video ||
    video.readyState < 2 ||
    video.videoWidth === 0 ||
    video.videoHeight === 0
  ) {
    return {
      dataUrl: null,
      report: buildUnperformedReport(
        'No active video frame was ready to capture, so image quality could not be checked. Wait a moment for the camera preview to stabilize and say Take picture again.'
      ),
    };
  }

  try {
    const target = computeScaledDimensions(
      video.videoWidth,
      video.videoHeight,
      MAX_CAPTURE_DIMENSION
    );

    const previewCanvas = document.createElement('canvas');
    previewCanvas.width = target.width;
    previewCanvas.height = target.height;
    const previewCtx = previewCanvas.getContext('2d');

    // Normalized analysis canvas for fast, consistent pixel metrics
    const analysisCanvas = document.createElement('canvas');
    analysisCanvas.width = ANALYSIS_WIDTH;
    analysisCanvas.height = ANALYSIS_HEIGHT;
    const analysisCtx = analysisCanvas.getContext('2d', { willReadFrequently: true });

    if (!previewCtx || !analysisCtx) {
      return {
        dataUrl: null,
        report: buildUnperformedReport(
          'Your browser could not create an image buffer to verify photo quality. Please try again.'
        ),
      };
    }

    previewCtx.imageSmoothingEnabled = true;
    previewCtx.imageSmoothingQuality = 'high';
    previewCtx.drawImage(video, 0, 0, previewCanvas.width, previewCanvas.height);
    analysisCtx.drawImage(video, 0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);

    const imageData = analysisCtx.getImageData(0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);
    const report = analyzeImageDataQuality(imageData);
    const dataUrl = previewCanvas.toDataURL('image/jpeg', JPEG_CAPTURE_QUALITY);

    return { dataUrl, report };
  } catch {
    return {
      dataUrl: null,
      report: buildUnperformedReport(
        'Capturing the camera frame failed, so quality checks were not performed. Please try again.'
      ),
    };
  }
}

/**
 * Evaluates a live video frame without keeping an image, for on-demand framing & lighting checks.
 */
export function evaluateLiveVideoFrame(video: HTMLVideoElement | null): ImageQualityReport {
  if (
    !video ||
    video.readyState < 2 ||
    video.videoWidth === 0 ||
    video.videoHeight === 0
  ) {
    return buildUnperformedReport(
      'The camera preview is not ready yet, so a live framing check could not be performed.'
    );
  }

  try {
    const analysisCanvas = document.createElement('canvas');
    analysisCanvas.width = ANALYSIS_WIDTH;
    analysisCanvas.height = ANALYSIS_HEIGHT;
    const analysisCtx = analysisCanvas.getContext('2d', { willReadFrequently: true });
    if (!analysisCtx) {
      return buildUnperformedReport(
        'Unable to read the camera preview buffer to check lighting and framing.'
      );
    }
    analysisCtx.drawImage(video, 0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);
    const imageData = analysisCtx.getImageData(0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);
    return analyzeImageDataQuality(imageData);
  } catch {
    return buildUnperformedReport(
      'Live framing check could not be performed on this device.'
    );
  }
}
