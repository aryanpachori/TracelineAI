const PAPER = "#f4f7fb";
const DESK = `radial-gradient(920px 420px at 0% -8%, #d8f6ec 0%, transparent 58%), radial-gradient(760px 380px at 100% -6%, #dce8ff 0%, transparent 52%), ${PAPER}`;
const MAX_CANVAS = 32000;

export async function captureReportPdf(sheet: HTMLElement): Promise<Uint8Array> {
  const { domToCanvas } = await import("modern-screenshot");
  const { jsPDF } = await import("jspdf");
  await document.fonts.ready;

  const width = sheet.offsetWidth;
  if (width < 32) throw new Error("The file is not on screen.");

  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = `position:fixed;left:0;top:0;transform:translateX(-120%);width:${width}px;pointer-events:none;background:${PAPER};`;

  const frame = document.createElement("div");
  frame.style.cssText = `width:${width}px;overflow:hidden;background:${PAPER};`;

  const page = document.createElement("div");
  page.style.cssText = `width:${width}px;background:${DESK};`;

  const header = sheet.ownerDocument.querySelector("header");
  if (header) page.appendChild(header.cloneNode(true));

  const clone = sheet.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(".no-print, .fixed").forEach((node) => node.remove());
  clone.querySelectorAll(".overflow-auto, .overflow-x-auto, .overflow-y-auto").forEach((node) => {
    const el = node as HTMLElement;
    el.style.overflow = "visible";
    el.style.maxHeight = "none";
  });
  clone.querySelectorAll(".sticky").forEach((node) => {
    (node as HTMLElement).style.position = "static";
  });
  page.appendChild(clone);
  frame.appendChild(page);
  host.appendChild(frame);
  document.body.appendChild(host);

  try {
    await nextFrame();
    await rasterizeCharts(page, sheet);
    const total = page.scrollHeight;
    const pageCss = Math.max(1, Math.floor(width * (841.89 / 595.28)));
    const slices = pack(page, pageCss, total);
    const scale = total * 2 <= MAX_CANVAS ? 2 : 1;
    const chunkCss = Math.floor(MAX_CANVAS / scale);
    const pdf = new jsPDF({ unit: "pt", format: "a4", compress: true });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    let placed = false;

    for (let index = 0; index < slices.length; ) {
      const start = slices[index].start;
      let endIndex = index;
      while (endIndex < slices.length && slices[endIndex].end - start <= chunkCss) endIndex += 1;
      if (endIndex === index) endIndex += 1;
      const end = slices[endIndex - 1].end;
      const windowHeight = Math.max(1, end - start);
      frame.style.height = `${windowHeight}px`;
      page.style.marginTop = `-${start}px`;
      await nextFrame();
      const canvas = await domToCanvas(frame, {
        scale,
        backgroundColor: PAPER,
        width,
        height: windowHeight,
        font: { preferredFormat: "woff2" },
      });
      paintCharts(frame, canvas);
      const pxPerCss = canvas.width / width;
      for (let sliceIndex = index; sliceIndex < endIndex; sliceIndex += 1) {
        const slice = slices[sliceIndex];
        const sy = Math.max(0, Math.round((slice.start - start) * pxPerCss));
        const sh = Math.max(1, Math.round((slice.end - slice.start) * pxPerCss));
        const tile = crop(canvas, sy, Math.min(sh, canvas.height - sy));
        const img = tile.toDataURL("image/jpeg", 0.92);
        if (placed) pdf.addPage();
        placed = true;
        pdf.setFillColor(244, 247, 251);
        pdf.rect(0, 0, pageW, pageH, "F");
        const drawH = ((slice.end - slice.start) / width) * pageW;
        pdf.addImage(img, "JPEG", 0, 0, pageW, Math.min(drawH, pageH));
        tile.width = 0;
        tile.height = 0;
      }
      canvas.width = 0;
      canvas.height = 0;
      index = endIndex;
    }

    return new Uint8Array(pdf.output("arraybuffer"));
  } finally {
    host.remove();
  }
}

function crop(canvas: HTMLCanvasElement, sy: number, sh: number) {
  const tile = document.createElement("canvas");
  tile.width = canvas.width;
  tile.height = sh;
  const ctx = tile.getContext("2d");
  if (!ctx) return canvas;
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, tile.width, tile.height);
  ctx.drawImage(canvas, 0, sy, canvas.width, sh, 0, 0, canvas.width, sh);
  return tile;
}

function pack(root: HTMLElement, pageCss: number, total: number) {
  const cuts = cutPoints(root, total);
  const pages: { start: number; end: number }[] = [];
  let start = 0;
  while (start < total - 2) {
    const limit = start + pageCss;
    const snap = cuts.filter((cut) => cut > start + 24 && cut <= limit + 1).at(-1);
    let end = snap ?? Math.min(total, limit);
    if (end <= start) end = Math.min(total, start + pageCss);
    pages.push({ start, end: Math.min(total, end) });
    start = Math.min(total, end);
  }
  if (!pages.length) pages.push({ start: 0, end: total });
  return pages;
}

function cutPoints(root: HTMLElement, total: number) {
  const top = root.getBoundingClientRect().top;
  const cuts = new Set<number>([0, Math.round(total)]);
  const nodes = [...root.querySelectorAll("header, section, tr")];
  const article = root.querySelector("article");
  if (article) nodes.push(...article.children);
  nodes.forEach((node) => {
    const bottom = Math.round(node.getBoundingClientRect().bottom - top);
    if (bottom > 0 && bottom < total) cuts.add(bottom);
  });
  return [...cuts].sort((a, b) => a - b);
}

async function rasterizeCharts(root: HTMLElement, live: HTMLElement) {
  const copies = [...root.querySelectorAll("svg")];
  const sources = [...live.querySelectorAll("svg")];
  for (let index = 0; index < copies.length; index += 1) {
    const source = sources[index];
    const target = copies[index];
    if (!(source instanceof SVGSVGElement) || !(target instanceof SVGSVGElement)) continue;
    const width = Math.round(source.clientWidth || Number(source.getAttribute("width")) || 0);
    const height = Math.round(source.clientHeight || Number(source.getAttribute("height")) || 0);
    if (width < 2 || height < 2) continue;
    try {
      const copy = source.cloneNode(true) as SVGSVGElement;
      copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      copy.setAttribute("width", String(width));
      copy.setAttribute("height", String(height));
      const xml = new XMLSerializer().serializeToString(copy);
      const image = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`);
      const canvas = document.createElement("canvas");
      canvas.width = width * 2;
      canvas.height = height * 2;
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      ctx.scale(2, 2);
      ctx.drawImage(image, 0, 0, width, height);
      const img = document.createElement("img");
      img.src = canvas.toDataURL("image/png");
      img.alt = "";
      img.style.width = `${width}px`;
      img.style.height = `${height}px`;
      img.style.display = "block";
      await img.decode();
      img.dataset.chart = "1";
      target.replaceWith(img);
    } catch {
      // Leave the drawing in place if it cannot be copied.
    }
  }
}

function paintCharts(frame: HTMLElement, canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d");
  if (!ctx || !canvas.width) return;
  const scale = canvas.width / Math.max(1, frame.clientWidth);
  const frameRect = frame.getBoundingClientRect();
  frame.querySelectorAll<HTMLImageElement>("img[data-chart]").forEach((img) => {
    const rect = img.getBoundingClientRect();
    const x = (rect.left - frameRect.left) * scale;
    const y = (rect.top - frameRect.top) * scale;
    const w = rect.width * scale;
    const h = rect.height * scale;
    if (w < 2 || h < 2) return;
    if (y + h < 0 || y > canvas.height || x + w < 0 || x > canvas.width) return;
    ctx.drawImage(img, x, y, w, h);
  });
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("chart"));
    image.src = src;
  });
}

function nextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}
