# EmbedPDF mark-up evaluation

Standalone page to test the PDF mark-up tools the client needs, using the
stable open-source EmbedPDF snippet (Apache-2.0, no licence key).

## Run

```bash
npm install
npm run dev
```

Open http://localhost:5180 and upload a PDF, or click **Load sample PDF**.
Marks are saved with the author "Proofed"; add `?author=Name` to the URL
to change it (the field is hidden in the header for now).

## Deploy

Static Vite site, no server. On Vercel: import the repo, framework
preset Vite, build command `vite build`, output `dist`. The PDF engine
is a 4.6 MB WASM file, so the first load takes a moment.

## Toolbar

The viewer is trimmed to the mark-up tools the client asked for:
highlight, underline, strikeout, Text, Replace Text, Insert Text,
comment, colours, undo and redo. Shapes, drawing, squiggly, callout,
stamps, signatures, forms and redaction are switched off through the
snippet's `disabledCategories` option; callout, which shares a category
with Text, is hidden by `dropCalloutTool` in `main.js`.

## What to test

| # | Feature | How, in the viewer |
|---|---|---|
| 1 | Replace selected text | Annotate tab, click Replace Text, drag across the old text, type the new text in the sidebar comment box |
| 2 | Insert text | Annotate tab, click Insert Text, drag across the word before the gap (a click alone does nothing), type the missing text in the sidebar |
| 3 | Strikethrough | Select text, Strikeout |
| 4 | Sticky note | Comment tool, click on the page, type |
| 5 | Highlight with comment | Select text, Highlight, add a comment in the sidebar |
| 6 | Comments panel with replies | Open the comments sidebar, reply to a thread |
| 7 | Edit and delete | Select a mark, change its text or press Delete |
| 8 | Colours | Select a mark, pick a colour in the style popover |
| 9 | Author name | Set the Author field before uploading, check it in the sidebar |
| 10 | Navigation, zoom, search | Toolbar |

## Acrobat round-trip

Click **Download annotated PDF**, open the file in Acrobat, and check that
the Replace and Insert marks show as Acrobat's own Replace Text and Insert
Text annotations with the right author.

To check the file without Acrobat, list its annotations:

```bash
node verify-annotations.mjs ~/Downloads/sample.pdf
```

A Replace mark is a `/Caret` with intent `/Replace` plus a `/StrikeOut` that
points back to it with `/RT /Group`. An Insert mark is a `/Caret` with intent
`/Insert`. A sticky note is `/Text`. Every entry carries the author in `/T`.

Verified on 14 Oct 2026 with the bundled sample: Replace, Insert, Underline
and sticky note all round-tripped with author "Proofed".

## Draft round trip (crash recovery)

The creative portal saves an editor's own marks as JSON every few
seconds (the `PdfAnnotations` content version) and replays them if the
job is reopened after a crash. The demo does the same with EmbedPDF:

1. **Export draft (JSON)** (header button): `exportAnnotations()`,
   filtered to the current author, wrapped in a versioned envelope,
   saved to local storage and downloaded as `pdf-annotations-draft.json`.
2. **Reload clean PDF** and **Restore draft** are hidden in the header
   for now (remove the `hidden` attribute in `index.html` to show them).
   Restore runs `importAnnotations()` with the saved items, then
   `commit()`, and the marks reappear with the same author and text. A
   `?draft=` link runs it automatically after the conversion below.

Verified on 15 Oct 2026: a Replace mark (caret plus grouped strikeout)
and a sticky note exported, the clean file reloaded with zero marks,
restore brought all three back, and the saved file carried them with
the strikeout still linked to its caret (`/IRT` plus `/RT /Group`), so
Acrobat lists one Replace entry, not two.

Two things the real integration must copy from `restoreDraft`:

- **Revive the dates.** JSON turns `created` and `modified` into
  strings. The engine writes dates with Date methods and stops applying
  the remaining properties, the reply link included, when it meets a
  string. Without this the marks come back but the Replace pair is
  split into a separate strikeout and caret.
- **Import parents before children.** Import the marks without
  `inReplyToId` first and commit, then the ones with it. The engine
  looks the parent up by name in the page, so it has to exist already.

## Old Adobe drafts (orders already in progress at the switch-over)

The portal's existing `PdfAnnotations` versions (payload version 1) hold
Adobe's W3C Web Annotation shape, which EmbedPDF cannot import as is.
`main.js` carries a small converter for the mark types Adobe Embed can
write (highlight, underline, squiggly, strikeout, note, free text):
page index, author, text and dates map one to one, and the geometry is
flipped from Adobe's bottom-left origin to EmbedPDF's top-left origin
using the page height.

Try it on a real draft: download an order's Original (or the previous
job's EditedCopyInternal) and its latest PdfAnnotations version from the
test backend, put them under `public/order<id>/` (that folder is
git-ignored, so real files never reach the repo), and open:

```
http://localhost:5180/?author=Reviewer&src=/order21776/14563-EditedCopyInternal-job27548.pdf&draft=/order21776/14566-PdfAnnotations-job27549.json
```

The draft is converted and restored on load. Verified on 15 Oct 2026: the three
Reviewer marks land on the same words, with the same author, text and
dates, as in the file the reviewer actually submitted (14567). Rects
differ by under 3 points because Adobe pads its saved rectangle.

### Command-line converter

The same converter runs from the terminal, for checking or migrating
stored drafts without opening the browser:

```bash
cp .env.example .env     # once: fill in OMS_API_KEY and OMS_REQUESTER_ID
npm run convert -- --adobe <PdfAnnotations.json>
```

`--adobe` is the PdfAnnotations content version (the blob is JSON even
though OMS names it `.pdf`). The coordinate flip needs each page's
height, which the Adobe draft does not carry, so the script reads it
from the PDF the draft was made on: the seed version named inside the
JSON (the order's Original for the first job, the previous job's
EditedCopyInternal after that). With the credentials in `.env` the
script downloads that seed from OMS by itself and keeps it next to the
JSON as `seed-<version>.pdf`; alternatively pass the file with
`--pdf <seed.pdf>`. The output, `<name>-embedpdf.json` next to the input
unless `--out` is given, is a version 2 draft that the page restores as
is through `?draft=`. Skipped marks (the pen `shape` type, or a page
missing from the PDF) are listed on stderr; a version 2 file passed as
input is rejected. Both the page and the script import
`adobe-draft-converter.ts`, so they cannot drift apart. Node 22 runs
the TypeScript directly; `.env` is git-ignored.

Adobe's freehand `shape` marks are not converted. If the switch-over has
to preserve those too, add an ink mapping; otherwise schedule it for a
quiet moment and accept that in-flight drafts of that one type are lost.

## Notes

- The PDFium WASM engine is served locally from `node_modules`. Fonts and
  stamps are fetched from jsDelivr and are optional.
- Changing the author re-creates the viewer, so re-upload the PDF after.
