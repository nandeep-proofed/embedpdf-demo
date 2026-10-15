import EmbedPDF from "@embedpdf/snippet";
import wasmPath from "@embedpdf/snippet/dist/pdfium.wasm?url";

// The engine runs in a blob: worker, so a root-relative path cannot resolve.
const wasmUrl = new URL(wasmPath, window.location.origin).href;

const authorInput = document.getElementById("author");
const fileInput = document.getElementById("file");
const downloadButton = document.getElementById("download");
const statusText = document.getElementById("status");

const setStatus = (message) => {
  statusText.textContent = message;
};

// Callout and Text share the "annotation-text" category, so to keep Text
// the callout button gets a category of its own and that one is disabled.
// The button sits inside a group in the Annotate toolbar and items are
// hidden by CSS keyed on their own category list, so the schema item is
// tagged in place, the category map is updated to match, the stylesheet
// is regenerated, and the public setDisabledCategories call applies it.
const walkItems = (items, visit) =>
  items.forEach((item) => {
    visit(item);
    if (item.items) walkItems(item.items, visit);
  });

const dropCalloutTool = (instance) =>
  instance.registry.then((registry) => {
    const uiPlugin = registry.getPlugin("ui");
    const ui = uiPlugin.provides();
    walkItems(ui.getSchema().toolbars["annotation-toolbar"].items, (item) => {
      if (item.id === "add-callout" && !item.categories.includes("callout")) {
        item.categories.push("callout");
      }
    });
    ["add-callout", "annotation:add-callout"].forEach((key) => {
      const categories = uiPlugin.itemCategories.get(key) ?? [];
      uiPlugin.itemCategories.set(key, [...categories, "callout"]);
    });
    // Hiding is done by a generated stylesheet with one rule per known
    // category, so it has to be rebuilt now that "callout" exists.
    uiPlugin.invalidateStylesheet();
    uiPlugin.stylesheetInvalidated$.emit();
    ui.setDisabledCategories([...ui.getDisabledCategories(), "callout"]);
  });

// The viewer can open a file on its own (Open Document button, the menu,
// drag and drop), so button state follows the document-manager events
// rather than this page's upload helpers.
const watchDocuments = (instance, author) =>
  instance.registry.then((registry) => {
    const documentManager = registry
      .getPlugin("document-manager")
      .provides();
    documentManager.onDocumentOpened((state) => {
      downloadButton.disabled = false;
      setStatus(`${state.name ?? "Document"} loaded.`);
    });
    documentManager.onDocumentClosed(() => {
      if (!documentManager.getActiveDocumentId()) {
        downloadButton.disabled = true;
        setStatus("No document loaded");
      }
    });
  });

const createViewer = (author) => {
  const instance = EmbedPDF.init({
    type: "container",
    target: document.getElementById("pdf-viewer"),
    wasmUrl,
    worker: true,
    tabBar: "never",
    // Only the mark-up tools the client asked for: no shapes, drawing,
    // squiggly, stamps, signatures, forms or redaction. Callout shares a
    // category with the Text tool, so it is dropped from the toolbar below.
    disabledCategories: [
      "mode-shapes",
      "mode-insert",
      "mode-form",
      "mode-redact",
      "annotation-shape",
      "annotation-ink",
      "annotation-squiggly",
      "insert",
      "form",
      "redaction"
    ],
    annotations: {
      annotationAuthor: author,
      autoCommit: true,
      selectAfterCreate: true
    },
    export: { defaultFileName: "annotated.pdf" },
    permissions: { enforceDocumentPermissions: false }
  });
  dropCalloutTool(instance).catch((error) =>
    console.error("dropCalloutTool", error)
  );
  watchDocuments(instance, author).catch((error) =>
    console.error("watchDocuments", error)
  );
  return instance;
};

// Query string shortcuts for testers: ?author=Reviewer&src=/order21776/x.pdf
const params = new URLSearchParams(window.location.search);
if (params.get("author")) authorInput.value = params.get("author");

let viewer = createViewer(authorInput.value.trim() || "Proofed");

const getCapability = async (pluginId) => {
  const registry = await viewer.registry;
  return registry.getPlugin(pluginId).provides();
};

const openFile = async (file) => {
  setStatus(`Loading ${file.name}...`);
  const buffer = await file.arrayBuffer();
  const documentManager = await getCapability("document-manager");
  const activeId = documentManager.getActiveDocumentId();
  if (activeId) {
    await documentManager.closeDocument(activeId).toPromise();
  }
  await documentManager
    .openDocumentBuffer({ buffer, name: file.name })
    .toPromise();
};

fileInput.addEventListener("change", () => {
  const [file] = fileInput.files;
  if (file) openFile(file).catch((error) => setStatus(`Load failed: ${error.message ?? error}`));
});

document.getElementById("sample").addEventListener("click", async () => {
  const response = await fetch("/sample.pdf");
  const blob = await response.blob();
  openFile(new File([blob], "sample.pdf", { type: "application/pdf" })).catch(
    (error) => setStatus(`Load failed: ${error.message ?? error}`)
  );
});

downloadButton.addEventListener("click", async () => {
  const exporter = await getCapability("export");
  exporter.download();
  setStatus("Download started. Open the file in Acrobat to confirm the marks.");
});

// The author is read at annotation-creation time from the plugin config, so
// changing it means re-creating the viewer. Re-upload the file afterwards.
authorInput.addEventListener("change", () => {
  const author = authorInput.value.trim() || "Proofed";
  document.getElementById("pdf-viewer").replaceChildren();
  viewer = createViewer(author);
  downloadButton.disabled = true;
  fileInput.value = "";
  setStatus(`Author set to "${author}". Upload the PDF again.`);
});

const openFromUrl = async (src) => {
  const response = await fetch(src);
  if (!response.ok) throw new Error(`${src}: ${response.status}`);
  const blob = await response.blob();
  const name = src.split("/").pop() || "document.pdf";
  await openFile(new File([blob], name, { type: "application/pdf" }));
};

if (params.get("src")) {
  viewer.registry.then(() => openFromUrl(params.get("src"))).catch((error) =>
    setStatus(`Load failed: ${error.message ?? error}`)
  );
}

// Log every annotation event so the console shows what was written.
viewer.registry.then((registry) => {
  const annotation = registry.getPlugin("annotation").provides();
  annotation.onAnnotationEvent((event) => {
    const subtype = event.annotation?.object?.type ?? event.annotation?.object?.subtype;
    console.log("[embedpdf]", event.type, subtype, event.annotation?.object);
  });
});

// ---------------------------------------------------------------------
// Draft round trip: the same idea as the creative portal's
// PdfAnnotations version. Export this author's marks as JSON, reopen
// the clean document so the marks are gone, then import the JSON and
// check the marks come back.
// ---------------------------------------------------------------------

const DRAFT_VERSION = 2;
const DRAFT_STORAGE_KEY = "embedpdf-demo.draft";

const exportButton = document.getElementById("export");
const reloadButton = document.getElementById("reload");
const restoreButton = document.getElementById("restore");

const getAnnotationCapability = () => getCapability("annotation");

const buildDraft = (items, author) => ({
  version: DRAFT_VERSION,
  author,
  savedAt: new Date().toISOString(),
  annotations: items.map((item) => ({
    page: item.annotation.pageIndex,
    annotation: item.annotation,
    ctx: item.ctx
  }))
});

const exportDraft = async () => {
  const author = authorInput.value.trim() || "Proofed";
  const annotation = await getAnnotationCapability();
  const items = await annotation.exportAnnotations().toPromise();
  const own = items.filter((item) => item.annotation.author === author);
  const draft = buildDraft(own, author);
  const json = JSON.stringify(draft, null, 2);

  localStorage.setItem(DRAFT_STORAGE_KEY, json);
  console.log("[embedpdf] exported draft", draft);

  const blob = new Blob([json], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "pdf-annotations-draft.json";
  link.click();
  URL.revokeObjectURL(link.href);

  reloadButton.disabled = false;
  setStatus(
    `Exported ${own.length} of ${items.length} marks by "${author}" to pdf-annotations-draft.json and local storage.`
  );
};

const reloadCleanDocument = async () => {
  const response = await fetch("/sample.pdf");
  const blob = await response.blob();
  await openFile(new File([blob], "sample.pdf", { type: "application/pdf" }));
  const annotation = await getAnnotationCapability();
  const remaining = annotation.getAnnotations().length;

  restoreButton.disabled = false;
  setStatus(`Clean sample reloaded: ${remaining} marks on the page.`);
};

const restoreDraft = async () => {
  const json = localStorage.getItem(DRAFT_STORAGE_KEY);
  const draft = json ? JSON.parse(json) : null;

  if (!draft || draft.version !== DRAFT_VERSION) {
    setStatus("No draft of the current version in local storage.");
    return;
  }

  const annotation = await getAnnotationCapability();
  const before = annotation.getAnnotations().length;

  // Parents first, then replies and grouped marks. A Replace mark is a
  // caret plus a strikeout that points at it, and the engine can only
  // write that link once the caret exists in the file. Importing both in
  // one batch kept the link in memory but dropped it from the PDF.
  // JSON turns the Date fields into strings. The engine writes dates
  // with Date methods and stops applying the rest of the properties,
  // the reply link included, when it meets a string. Revive them.
  const reviveDates = (object) => ({
    ...object,
    ...(object.created ? { created: new Date(object.created) } : {}),
    ...(object.modified ? { modified: new Date(object.modified) } : {})
  });
  const items = draft.annotations.map(({ annotation: object, ctx }) => ({
    annotation: reviveDates(object),
    ctx
  }));
  const roots = items.filter((item) => !item.annotation.inReplyToId);
  const children = items.filter((item) => item.annotation.inReplyToId);

  annotation.importAnnotations(roots);
  await annotation.commit().toPromise();
  annotation.importAnnotations(children);
  await annotation.commit().toPromise();

  const after = annotation.getAnnotations();
  const restored = after.filter((tracked) => tracked.object.author === draft.author);

  console.log("[embedpdf] restored draft", after.map((tracked) => tracked.object));
  setStatus(
    `Restored ${restored.length} marks by "${draft.author}" (page had ${before}, now ${after.length}). Download to verify.`
  );
};

const guard = (run) => () =>
  run().catch((error) => {
    console.error("[embedpdf]", error);
    setStatus(`Failed: ${error?.message ?? error}`);
  });

exportButton.addEventListener("click", guard(exportDraft));
reloadButton.addEventListener("click", guard(reloadCleanDocument));
restoreButton.addEventListener("click", guard(restoreDraft));

// Enable Export once a document is open: openFile() enables Download,
// so mirror that here without touching the original helper.
new MutationObserver(() => {
  const noDocument = downloadButton.disabled;
  exportButton.disabled = noDocument;
  reloadButton.disabled = noDocument;
  restoreButton.disabled = noDocument || !localStorage.getItem(DRAFT_STORAGE_KEY);
}).observe(downloadButton, { attributes: true, attributeFilter: ["disabled"] });

// ---------------------------------------------------------------------
// Old-format drafts. The portal's PdfAnnotations version (payload
// version 1) holds Adobe's W3C Web Annotation shape. This converts the
// mark types Adobe Embed can write into EmbedPDF objects so a job that
// was mid-flight at the switch-over can still get its draft back.
//   ?draft=/order21776/14566-PdfAnnotations-job27549.json
// ---------------------------------------------------------------------

const ADOBE_SUBTYPE_TO_TYPE = {
  highlight: 9,
  underline: 10,
  squiggly: 11,
  strikeout: 12,
  note: 1,
  freetext: 3
};

// Adobe: PDF points, origin bottom-left, box as [x1, y1, x2, y2].
// EmbedPDF: PDF points, origin top-left, box as origin + size.
const flipBox = ([x1, y1, x2, y2], pageHeight) => ({
  origin: { x: x1, y: pageHeight - y2 },
  size: { width: x2 - x1, height: y2 - y1 }
});

const quadsToRects = (quads, pageHeight) => {
  const rects = [];
  for (let index = 0; index + 7 < quads.length; index += 8) {
    const xs = [quads[index], quads[index + 2], quads[index + 4], quads[index + 6]];
    const ys = [quads[index + 1], quads[index + 3], quads[index + 5], quads[index + 7]];
    rects.push(flipBox([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], pageHeight));
  }
  return rects;
};

const convertAdobeAnnotation = (adobe, pageHeights) => {
  const selector = adobe.target?.selector ?? {};
  const type = ADOBE_SUBTYPE_TO_TYPE[selector.subtype];
  const pageIndex = selector.node?.index ?? 0;
  const pageHeight = pageHeights[pageIndex];
  if (!type || !selector.boundingBox || pageHeight === undefined) {
    console.warn("[embedpdf] skipped Adobe mark", selector.subtype, adobe.id);
    return null;
  }
  const base = {
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
    return { ...base, color: selector.strokeColor ?? "#FFC100", rect: { ...base.rect, size: { width: 24, height: 24 } } };
  }
  if (type === 3) {
    return { ...base, fontFamily: 0, fontSize: 12, fontColor: selector.strokeColor ?? "#000000", textAlign: 0, verticalAlign: 0 };
  }
  return {
    ...base,
    color: selector.strokeColor,
    strokeColor: selector.strokeColor,
    segmentRects: selector.quadPoints ? quadsToRects(selector.quadPoints, pageHeight) : [base.rect]
  };
};

const convertAdobeDraft = (adobeDraft, pageHeights) => {
  const converted = adobeDraft.annotations
    .map((entry) => convertAdobeAnnotation(entry.annotation, pageHeights))
    .filter(Boolean);
  return {
    version: DRAFT_VERSION,
    author: converted[0]?.author ?? "Proofed",
    savedAt: adobeDraft.savedAt,
    convertedFrom: { version: adobeDraft.version, jobId: adobeDraft.jobId, seedVersionId: adobeDraft.seedVersionId },
    annotations: converted.map((object) => ({ page: object.pageIndex, annotation: object }))
  };
};

const loadAdobeDraft = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const adobeDraft = await response.json();
  if (adobeDraft.version !== 1) throw new Error(`Expected a version 1 (Adobe) draft, got ${adobeDraft.version}`);
  const documentManager = await getCapability("document-manager");
  const pages = documentManager.getActiveDocument()?.pages ?? [];
  const pageHeights = pages.map((page) => page.size.height);
  const draft = convertAdobeDraft(adobeDraft, pageHeights);
  localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
  restoreButton.disabled = false;
  console.log("[embedpdf] converted Adobe draft", adobeDraft, "->", draft);
  setStatus(
    `Converted Adobe draft: ${draft.annotations.length} of ${adobeDraft.annotations.length} marks by "${draft.author}" ready. Click 3. Restore draft.`
  );
};

if (params.get("draft")) {
  // Wait for the document from ?src= to be open first.
  const waitForDocument = () =>
    new Promise((resolve) => {
      const check = () => (downloadButton.disabled ? setTimeout(check, 200) : resolve());
      check();
    });
  waitForDocument()
    .then(() => loadAdobeDraft(params.get("draft")))
    .catch((error) => setStatus(`Draft load failed: ${error.message ?? error}`));
}
