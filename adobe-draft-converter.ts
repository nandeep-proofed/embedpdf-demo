// Converts the creative portal's PdfAnnotations draft (payload version 1,
// written by the Adobe PDF Embed viewer in W3C Web Annotation shape) into
// the EmbedPDF draft used by this demo (payload version 2). Shared by the
// browser page (main.js) and the command-line script
// (convert-adobe-draft.ts), so both produce byte-for-byte the same result.

export const DRAFT_VERSION = 2;

export interface AdobeSelector {
  boundingBox?: number[];
  node?: { index?: number };
  opacity?: number;
  quadPoints?: number[];
  strokeColor?: string;
  subtype?: string;
}

export interface AdobeAnnotation {
  bodyValue?: string;
  created?: string;
  creator?: { name?: string };
  id: string;
  modified?: string;
  target?: { selector?: AdobeSelector; source?: string };
}

export interface AdobeDraft {
  annotations: Array<{ annotation: AdobeAnnotation; page?: number }>;
  jobId?: number;
  orderId?: number;
  savedAt?: string;
  seedVersionId?: number;
  version: number;
}

export interface Rect {
  origin: { x: number; y: number };
  size: { width: number; height: number };
}

export interface EmbedPdfAnnotation {
  author?: string;
  color?: string;
  contents: string;
  created?: Date;
  fontColor?: string;
  fontFamily?: number;
  fontSize?: number;
  id: string;
  modified?: Date;
  opacity: number;
  pageIndex: number;
  rect: Rect;
  segmentRects?: Rect[];
  strokeColor?: string;
  textAlign?: number;
  type: number;
  verticalAlign?: number;
}

export interface EmbedPdfDraft {
  annotations: Array<{ annotation: EmbedPdfAnnotation; page: number }>;
  author: string;
  convertedFrom: { jobId?: number; seedVersionId?: number; version: number };
  savedAt?: string;
  version: number;
}

export interface SkippedMark {
  id: string;
  reason: string;
  subtype?: string;
}

export interface ConversionResult {
  draft: EmbedPdfDraft;
  skipped: SkippedMark[];
}

// Adobe subtype -> PdfAnnotationSubtype used by EmbedPDF.
const ADOBE_SUBTYPE_TO_TYPE: Record<string, number> = {
  highlight: 9,
  underline: 10,
  squiggly: 11,
  strikeout: 12,
  note: 1,
  freetext: 3
};

// Adobe: PDF points, origin bottom-left, box as [x1, y1, x2, y2].
// EmbedPDF: PDF points, origin top-left, box as origin + size.
const flipBox = ([x1, y1, x2, y2]: number[], pageHeight: number): Rect => ({
  origin: { x: x1, y: pageHeight - y2 },
  size: { width: x2 - x1, height: y2 - y1 }
});

const quadsToRects = (quads: number[], pageHeight: number): Rect[] => {
  const rects: Rect[] = [];
  for (let index = 0; index + 7 < quads.length; index += 8) {
    const xs = [quads[index], quads[index + 2], quads[index + 4], quads[index + 6]];
    const ys = [quads[index + 1], quads[index + 3], quads[index + 5], quads[index + 7]];
    rects.push(
      flipBox([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], pageHeight)
    );
  }
  return rects;
};

export const convertAdobeAnnotation = (
  adobe: AdobeAnnotation,
  pageHeights: number[]
): EmbedPdfAnnotation | SkippedMark => {
  const selector = adobe.target?.selector ?? {};
  const type = selector.subtype ? ADOBE_SUBTYPE_TO_TYPE[selector.subtype] : undefined;
  const pageIndex = selector.node?.index ?? 0;
  const pageHeight = pageHeights[pageIndex];
  if (!type) {
    return { id: adobe.id, subtype: selector.subtype, reason: "mark type not converted" };
  }
  if (!selector.boundingBox) {
    return { id: adobe.id, subtype: selector.subtype, reason: "no bounding box" };
  }
  if (pageHeight === undefined) {
    return { id: adobe.id, subtype: selector.subtype, reason: `page ${pageIndex + 1} not in the PDF` };
  }
  const base: EmbedPdfAnnotation = {
    id: adobe.id,
    type,
    pageIndex,
    rect: flipBox(selector.boundingBox, pageHeight),
    author: adobe.creator?.name,
    contents: adobe.bodyValue ?? "",
    created: adobe.created ? new Date(adobe.created) : undefined,
    modified: adobe.modified ? new Date(adobe.modified) : undefined,
    opacity: selector.opacity ?? 1
  };
  if (type === 1) {
    return {
      ...base,
      color: selector.strokeColor ?? "#FFC100",
      rect: { ...base.rect, size: { width: 24, height: 24 } }
    };
  }
  if (type === 3) {
    return {
      ...base,
      fontFamily: 0,
      fontSize: 12,
      fontColor: selector.strokeColor ?? "#000000",
      textAlign: 0,
      verticalAlign: 0
    };
  }
  return {
    ...base,
    color: selector.strokeColor,
    strokeColor: selector.strokeColor,
    segmentRects: selector.quadPoints ? quadsToRects(selector.quadPoints, pageHeight) : [base.rect]
  };
};

const isSkipped = (value: EmbedPdfAnnotation | SkippedMark): value is SkippedMark =>
  "reason" in value;

export const convertAdobeDraft = (adobeDraft: AdobeDraft, pageHeights: number[]): ConversionResult => {
  if (adobeDraft.version !== 1) {
    throw new Error(`Expected a version 1 (Adobe) draft, got version ${adobeDraft.version}`);
  }
  const converted: EmbedPdfAnnotation[] = [];
  const skipped: SkippedMark[] = [];
  adobeDraft.annotations.forEach((entry) => {
    const result = convertAdobeAnnotation(entry.annotation, pageHeights);
    if (isSkipped(result)) skipped.push(result);
    else converted.push(result);
  });
  return {
    draft: {
      version: DRAFT_VERSION,
      author: converted[0]?.author ?? "Proofed",
      savedAt: adobeDraft.savedAt,
      convertedFrom: {
        version: adobeDraft.version,
        jobId: adobeDraft.jobId,
        seedVersionId: adobeDraft.seedVersionId
      },
      annotations: converted.map((object) => ({ page: object.pageIndex, annotation: object }))
    },
    skipped
  };
};
