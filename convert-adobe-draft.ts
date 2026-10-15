#!/usr/bin/env node
// Command-line converter: Adobe PdfAnnotations draft -> EmbedPDF draft.
//
//   node convert-adobe-draft.ts --adobe <draft.json> [--pdf <seed.pdf>] [--out <file.json>]
//
// The coordinate flip needs each page's height, which the Adobe draft
// does not carry, so the script reads it from the PDF the draft was made
// on (the seed version named inside the JSON). Pass that PDF with --pdf,
// or leave it out and the script downloads the seed version from OMS,
// using these environment variables:
//
//   OMS_API_KEY        the api-key header
//   OMS_REQUESTER_ID   the requesterId header
//   OMS_BASE_URL       optional, defaults to the test backend
//
// The downloaded seed is kept next to the JSON as seed-<version>.pdf and
// reused on later runs. Output goes to --out or next to the input as
// <name>-embedpdf.json. Exit code 0 even when some marks are skipped;
// they are listed on stderr.
import { access, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { PDFDocument } from "pdf-lib";

import { convertAdobeDraft, type AdobeDraft } from "./adobe-draft-converter.ts";

const DEFAULT_BASE_URL = "https://testbackend.proofed.com/SystemOfRecord/api";

const readArgs = () => {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const adobePath = get("--adobe");
  if (!adobePath) {
    console.error("Usage: node convert-adobe-draft.ts --adobe <draft.json> [--pdf <seed.pdf>] [--out <file.json>]");
    process.exit(2);
  }
  const outPath = get("--out") ?? join(dirname(adobePath), `${basename(adobePath).replace(/\.(json|pdf)$/i, "")}-embedpdf.json`);
  return { adobePath, pdfPath: get("--pdf"), outPath };
};

const exists = (path: string) => access(path).then(() => true, () => false);

// Downloads the seed version the draft names, through the OMS content
// versions API, and caches it next to the draft.
const fetchSeedPdf = async (adobeDraft: AdobeDraft, nextTo: string) => {
  const seedVersionId = adobeDraft.seedVersionId;
  if (!seedVersionId) {
    throw new Error("The draft has no seedVersionId, so pass the seed PDF with --pdf");
  }
  const cachePath = join(dirname(nextTo), `seed-${seedVersionId}.pdf`);
  if (await exists(cachePath)) return cachePath;

  const apiKey = process.env.OMS_API_KEY;
  const requesterId = process.env.OMS_REQUESTER_ID;
  if (!apiKey || !requesterId) {
    throw new Error(
      `Seed version ${seedVersionId} is needed for the page heights. Pass it with --pdf, or set OMS_API_KEY and OMS_REQUESTER_ID so it can be downloaded.`
    );
  }
  const baseUrl = process.env.OMS_BASE_URL ?? DEFAULT_BASE_URL;
  const headers = { "api-key": apiKey, requesterId, "Content-Type": "application/json" };
  const metaResponse = await fetch(`${baseUrl}/workItemContentVersions/${seedVersionId}`, { headers });
  if (!metaResponse.ok) {
    throw new Error(`OMS returned ${metaResponse.status} for content version ${seedVersionId}`);
  }
  const meta = (await metaResponse.json()) as { versionPath?: string; versionType?: string };
  if (!meta.versionPath) {
    throw new Error(`Content version ${seedVersionId} has no file to download`);
  }
  const fileResponse = await fetch(meta.versionPath);
  if (!fileResponse.ok) {
    throw new Error(`Could not download seed version ${seedVersionId}: ${fileResponse.status}`);
  }
  await writeFile(cachePath, Buffer.from(await fileResponse.arrayBuffer()));
  console.log(`Downloaded seed version ${seedVersionId} (${meta.versionType ?? "unknown type"}) to ${cachePath}`);
  return cachePath;
};

const main = async () => {
  const { adobePath, pdfPath, outPath } = readArgs();
  const adobeDraft = JSON.parse(await readFile(adobePath, "utf8")) as AdobeDraft;
  const seedPath = pdfPath ?? (await fetchSeedPdf(adobeDraft, adobePath));
  const pdf = await PDFDocument.load(await readFile(seedPath), { ignoreEncryption: true });
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
