/**
 * Deterministic minimal PDFs for tests, byte-for-byte the same construction as
 * `agentpkg/tests/pdf_fixtures.py`: Helvetica `Tj` lines per page, so the
 * trusted parser extracts exactly what was written. Nothing here is a paper.
 */
function escape(text: string): string {
  return text.replace(/\\/gu, "\\\\").replace(/\(/gu, "\\(").replace(/\)/gu, "\\)");
}

export function makePdf(pages: Array<string | string[]>): Buffer {
  const normalized = pages.map((page) => (typeof page === "string" ? [page] : page));
  const count = normalized.length;
  const fontNumber = 3 + 2 * count;
  const objects: Buffer[] = [];
  const kids = normalized.map((_, index) => `${3 + 2 * index} 0 R`).join(" ");
  objects.push(Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "latin1"));
  objects.push(Buffer.from(`<< /Type /Pages /Kids [${kids}] /Count ${count} >>`, "latin1"));
  normalized.forEach((lines, index) => {
    const contentNumber = 4 + 2 * index;
    objects.push(
      Buffer.from(
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
          `/Resources << /Font << /F1 ${fontNumber} 0 R >> >> ` +
          `/Contents ${contentNumber} 0 R >>`,
        "latin1",
      ),
    );
    const body =
      "BT /F1 12 Tf 72 720 Td 14 TL\n" + lines.map((line) => `(${escape(line)}) Tj T*`).join("\n") + "\nET";
    const stream = Buffer.from(body, "latin1");
    objects.push(
      Buffer.concat([
        Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, "latin1"),
        stream,
        Buffer.from("\nendstream", "latin1"),
      ]),
    );
  });
  objects.push(Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", "latin1"));

  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n%âãÏÓ\n", "latin1")];
  let length = parts[0]!.length;
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(length);
    const chunk = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, "latin1"),
      body,
      Buffer.from("\nendobj\n", "latin1"),
    ]);
    parts.push(chunk);
    length += chunk.length;
  });
  const xref = length;
  let tail = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) tail += `${String(offset).padStart(10, "0")} 00000 n \n`;
  tail += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  parts.push(Buffer.from(tail, "latin1"));
  return Buffer.concat(parts);
}
