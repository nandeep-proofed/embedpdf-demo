// Usage: node verify-annotations.mjs <file.pdf>
// Lists every annotation with subtype, intent, author, contents and reply links,
// so a downloaded file can be checked without opening Acrobat.
import { readFileSync } from "node:fs";
import { PDFDocument, PDFName, PDFDict, PDFString, PDFHexString, PDFRef } from "pdf-lib";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node verify-annotations.mjs <file.pdf>");
  process.exit(1);
}

const text = (value) =>
  value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : undefined;

const pdf = await PDFDocument.load(readFileSync(file), { ignoreEncryption: true });
pdf.getPages().forEach((page, pageIndex) => {
  const annots = page.node.Annots();
  if (!annots) return;
  annots.asArray().forEach((ref) => {
    const dict = pdf.context.lookup(ref);
    if (!(dict instanceof PDFDict)) return;
    const name = (key) => dict.get(PDFName.of(key))?.toString();
    const inReplyTo = dict.get(PDFName.of("IRT"));
    console.log({
      page: pageIndex + 1,
      ref: ref instanceof PDFRef ? ref.toString() : String(ref),
      subtype: name("Subtype"),
      intent: name("IT"),
      author: text(dict.get(PDFName.of("T"))),
      contents: text(dict.get(PDFName.of("Contents"))),
      inReplyTo: inReplyTo instanceof PDFRef ? inReplyTo.toString() : undefined,
      replyType: name("RT"),
      color: name("C")
    });
  });
});
