#!/usr/bin/env node
// Command-line converter: Adobe PdfAnnotations draft -> EmbedPDF draft.
//
//   node convert-adobe-draft.ts --adobe <draft.json> --pdf <seed.pdf> [--out <file.json>]
//
// The PDF is the document the draft was made on (the job's seed version:
// the order's Original for the first job, the previous job's
// EditedCopyInternal after that). It is only read for its page heights,
// which the coordinate flip needs. Output goes to --out or next to the
// input as <name>-embedpdf.json. Exit code 0 even when some marks are
// skipped; they are listed on stderr.
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { PDFDocument } from "pdf-lib";

import { convertAdobeDraft, type AdobeDraft } from "./adobe-draft-converter.ts";

const readArgs = () => {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const adobePath = get("--adobe");
  const pdfPath = get("--pdf");
  if (!adobePath || !pdfPath) {
    console.error("Usage: node convert-adobe-draft.ts --adobe <draft.json> --pdf <seed.pdf> [--out <file.json>]");
    process.exit(2);
  }
  const outPath = get("--out") ?? join(dirname(adobePath), `${basename(adobePath).replace(/\.(json|pdf)$/i, "")}-embedpdf.json`);
  return { adobePath, pdfPath, outPath };
};

const main = async () => {
  const { adobePath, pdfPath, outPath } = readArgs();
  const adobeDraft = JSON.parse(await readFile(adobePath, "utf8")) as AdobeDraft;
  const pdf = await PDFDocument.load(await readFile(pdfPath), { ignoreEncryption: true });
  const pageHeights = pdf.getPages().map((page) => page.getHeight());
  const { draft, skipped } = convertAdobeDraft(adobeDraft, pageHeights);
  await writeFile(outPath, JSON.stringify(draft, null, 2));

  const byType = draft.annotations.reduce<Record<string, number>>((counts, { annotation }) => {
    counts[String(annotation.type)] = (counts[String(annotation.type)] ?? 0) + 1;
    return counts;
  }, {});
  console.log(`Converted ${draft.annotations.length} of ${adobeDraft.annotations.length} marks from ${basename(adobePath)}`);
  console.log(`  seed version ${adobeDraft.seedVersionId ?? "?"}, job ${adobeDraft.jobId ?? "?"}, author ${draft.author}, pages ${pageHeights.length}`);
  console.log(`  by type: ${JSON.stringify(byType)} (9 highlight, 10 underline, 12 strikeout, 1 note, 3 free text)`);
  console.log(`  written to ${outPath}`);
  skipped.forEach((mark) => console.error(`  skipped ${mark.id} (${mark.subtype ?? "?"}): ${mark.reason}`));
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
