import { PdfFormatter } from 'chordsheetjs/pdf';
import { PDFDocument } from 'pdf-lib';
import { prepareSong, resolveEffectivePreferences } from './chords';
import { buildPdfConfig } from './pdf-config';
import { EMBEDDED_FONT } from './constants';
import { loadPdfFont, makePdfConstructor, unsupportedChars } from './pdf-fonts';
import type { Setlist } from '../types/setlist';
import type { ExportableSong } from './api';

// The library breaks pages mid-verse, so keep a song on one page where we can.
// Floor matches the app's own font scale.
const FIT_FLOOR = -3;

function download(bytes: Uint8Array, filename: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function loadFontFor(content: string): Promise<string | null> {
  try {
    return await loadPdfFont(content);
  } catch {
    throw new Error('Could not load the font needed for this song');
  }
}

async function renderOne(
  content: string,
  transpose: number,
  nashville: boolean,
  fontSize: number,
): Promise<Uint8Array> {
  const song = prepareSong(content, transpose, nashville);
  if (!song) throw new Error('Could not parse this song');

  const fontBase64 = await loadFontFor(content);
  const Doc = makePdfConstructor(fontBase64);
  const fontName = fontBase64 ? EMBEDDED_FONT : null;

  // chordsheetjs and chordsheetjs/pdf each declare their own Song class, so the
  // types don't match across entry points even though it's one object at runtime.
  const forPdf = song as unknown as Parameters<PdfFormatter['format']>[0];

  let requested: Uint8Array | null = null;
  for (let size = fontSize; ; size--) {
    const formatter = new PdfFormatter(buildPdfConfig({ fontName, fontSize: size }));
    formatter.format(forPdf, Doc);
    const wrapper = formatter.getDocumentWrapper();
    const bytes = new Uint8Array(wrapper.doc.output('arraybuffer'));
    requested ??= bytes;
    if (wrapper.totalPages === 1) return bytes;
    // Shrinking did not rescue it — don't punish the reader with tiny text.
    if (size <= FIT_FLOOR) return requested;
  }
}

interface SongData {
  title: string;
  artist: string;
  content: string;
  bpm: number | null;
}

interface SongExportOptions {
  transpose: number;
  nashville: boolean;
  fontSize: number;
}

/** Resolves to the characters no available font can draw (empty when all is well). */
export async function exportSongPdf(song: SongData, options: SongExportOptions): Promise<string[]> {
  const bytes = await renderOne(song.content, options.transpose, options.nashville, options.fontSize);
  const name = [song.title, song.artist].filter(Boolean).join(' - ') || 'song';
  download(bytes, `${name}.pdf`);
  return unsupportedChars(song.content);
}

export async function exportSetlistPdf(
  setlist: Setlist,
  globalSettings: { nashville: boolean; fontSize: number },
): Promise<string[]> {
  const entries = setlist.entries.filter((e) => !e.is_private_placeholder);
  if (!entries.length) throw new Error('No exportable songs in this setlist');

  const missing = new Set<string>();
  const parts: Uint8Array[] = [];

  for (const entry of entries) {
    const prefs = resolveEffectivePreferences(entry, {
      nashville: !!globalSettings.nashville,
      twoCol: false,
      fontSize: globalSettings.fontSize,
      hideYt: false,
    });
    const content = entry.content_override || entry.content;
    parts.push(await renderOne(content, entry.transpose, prefs.nashville, prefs.fontSize));
    unsupportedChars(content).forEach((c) => missing.add(c));
  }

  const merged = await PDFDocument.create();
  for (const part of parts) {
    const src = await PDFDocument.load(part);
    (await merged.copyPages(src, src.getPageIndices())).forEach((p) => merged.addPage(p));
  }

  download(await merged.save(), `${setlist.name || 'setlist'}.pdf`);
  return [...missing];
}

const TOC_ROWS_PER_PAGE = 38;

export function orderExportableSongs(songs: ExportableSong[]): ExportableSong[] {
  return [...songs].sort((a, b) =>
    a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) ||
    a.artist.localeCompare(b.artist, undefined, { sensitivity: 'base' }) ||
    a.id - b.id,
  );
}

export function librarySongPageNumbers(pageCounts: number[]): number[] {
  const tocPages = Math.max(1, Math.ceil(pageCounts.length / TOC_ROWS_PER_PAGE));
  let nextPage = tocPages + 1;
  return pageCounts.map((count) => {
    const page = nextPage;
    nextPage += count;
    return page;
  });
}

async function renderContents(
  songs: ExportableSong[],
  songPages: number[],
  fontText: string,
): Promise<Uint8Array> {
  const fontBase64 = await loadFontFor(fontText);
  const Doc = makePdfConstructor(fontBase64);
  const fontName = fontBase64 ? EMBEDDED_FONT : 'helvetica';
  const doc = new Doc({ unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();

  songs.forEach((song, index) => {
    if (index > 0 && index % TOC_ROWS_PER_PAGE === 0) doc.addPage();
    const row = index % TOC_ROWS_PER_PAGE;
    if (row === 0) {
      doc.setFont(fontName, 'bold');
      doc.setFontSize(20);
      doc.text('Contents', 48, 52);
    }

    const label = [song.title || 'Untitled song', song.artist].filter(Boolean).join(' — ');
    doc.setFont(fontName, 'normal');
    doc.setFontSize(10);
    const maxLabelWidth = pageWidth - 124;
    let displayed = label;
    while (displayed.length > 1 && doc.getTextWidth(`${displayed}…`) > maxLabelWidth) {
      displayed = displayed.slice(0, -1);
    }
    if (displayed !== label) displayed += '…';
    const y = 82 + row * 18;
    doc.text(displayed, 48, y);
    doc.text(String(songPages[index]), pageWidth - 48, y, { align: 'right' });
  });

  return new Uint8Array(doc.output('arraybuffer'));
}

/** Exports the complete accessible library as one indexed, printable PDF. */
export async function exportLibraryPdf(songs: ExportableSong[]): Promise<string[]> {
  if (!songs.length) throw new Error('No exportable songs in your library');

  const ordered = orderExportableSongs(songs);
  const parts: { bytes: Uint8Array; pages: number }[] = [];
  const missing = new Set<string>();

  for (const song of ordered) {
    const bytes = await renderOne(song.content, 0, false, 0);
    const pages = (await PDFDocument.load(bytes)).getPageCount();
    parts.push({ bytes, pages });
    unsupportedChars(`${song.title}\n${song.artist}\n${song.content}`).forEach((c) => missing.add(c));
  }

  const songPages = librarySongPageNumbers(parts.map((part) => part.pages));
  const tocText = ordered.map((song) => `${song.title}\n${song.artist}`).join('\n');
  const contents = await renderContents(ordered, songPages, tocText);

  const merged = await PDFDocument.create();
  for (const bytes of [contents, ...parts.map((part) => part.bytes)]) {
    const source = await PDFDocument.load(bytes);
    (await merged.copyPages(source, source.getPageIndices())).forEach((page) => merged.addPage(page));
  }

  const date = new Date().toISOString().slice(0, 10);
  download(await merged.save(), `chordvault-printable-${date}.pdf`);
  return [...missing];
}
