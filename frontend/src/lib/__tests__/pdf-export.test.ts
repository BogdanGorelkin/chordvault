import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { resolve } from 'node:path';
import {
  exportSongPdf,
  exportSetlistPdf,
  exportLibraryPdf,
  librarySongPageNumbers,
  orderExportableSongs,
} from '../pdf-export';
import type { ExportableSong } from '../api';
import { PDFDocument } from 'pdf-lib';
import type { Setlist, SetlistEntry } from '../../types/setlist';

// vitest root is frontend/; import.meta.url is not a file: URL under Vite
const FONT = resolve(process.cwd(), 'src/assets/NotoSansTC.ttf');

// Pull the drawn text back out of the PDF. Text is written as Identity-H glyph
// ids, so it has to be mapped back through the font's ToUnicode CMap — which is
// exactly what a PDF reader does when you select and copy.
function textOf(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes);
  const raw = buf.toString('latin1');
  const streams: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    try {
      streams.push(inflateSync(buf.subarray(start, end)).toString('latin1'));
    } catch {
      /* not a deflate stream */
    }
  }
  const map: Record<string, string> = {};
  for (const s of streams) {
    for (const block of s.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
      for (const p of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g))
        map[p[1].toLowerCase()] = String.fromCodePoint(parseInt(p[2], 16));
    for (const block of s.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))
      for (const p of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
        const [from, to, uni] = [parseInt(p[1], 16), parseInt(p[2], 16), parseInt(p[3], 16)];
        for (let i = from; i <= to; i++)
          map[i.toString(16).padStart(4, '0')] = String.fromCodePoint(uni + i - from);
      }
  }
  return [...streams.join('').matchAll(/<([0-9a-fA-F]+)>\s*Tj/g)]
    .map((x) => (x[1].match(/..../g) ?? []).map((g) => map[g.toLowerCase()] ?? '').join(''))
    .join('');
}

let capturedBlob: Blob;
const lastPdf = async () => new Uint8Array(await capturedBlob.arrayBuffer());

beforeAll(() => {
  const font = readFileSync(FONT);
  vi.stubGlobal('fetch', async () => new Response(font));
  // jsdom has no object URLs and won't follow a download, so intercept the blob.
  // Patch the statics only — replacing the whole URL global breaks `new URL()`.
  URL.createObjectURL = (blob: Blob) => {
    capturedBlob = blob;
    return 'blob:test';
  };
  URL.revokeObjectURL = () => {};
  // jsdom logs "navigation to another Document" for every download click
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

const song = (content: string, title = 'T') => ({ title, artist: 'A', content, bpm: null });
const opts = { transpose: 0, nashville: false, fontSize: 0 };

describe('exportSongPdf', () => {
  it('writes English lyrics as real text', async () => {
    await exportSongPdf(song('{key: G}\n[G]Amazing grace how [C]sweet the sound\n'), opts);
    expect(textOf(await lastPdf())).toContain('Amazing grace how');
  });

  // The release blocker: with the stock config CJK is dropped silently, with no
  // error and no tofu. If this ever fails, exported Chinese songs are missing text.
  it('writes Chinese lyrics as real text', async () => {
    await exportSongPdf(song('{key: G}\n[G]奇異恩典 何等甘[C]甜\n', '奇異恩典'), opts);
    const text = textOf(await lastPdf());
    for (const ch of '奇異恩典何等甘甜') expect(text).toContain(ch);
  });

  // Header items carry their own font settings and ignore fonts.*, so a CJK
  // title/artist vanishes unless those are patched too.
  it('keeps a CJK title and artist in the header', async () => {
    await exportSongPdf(song('{title: 奇異恩典}\n{artist: 讚美之泉}\n{key: G}\n[G]大同\n'), opts);
    const text = textOf(await lastPdf());
    expect(text).toContain('奇異恩典');
    expect(text).toContain('讚美之泉');
  });

  it('applies transpose', async () => {
    await exportSongPdf(song('{key: G}\n[G]a [C]b\n'), { ...opts, transpose: 2 });
    const text = textOf(await lastPdf());
    expect(text).toContain('A');
    expect(text).toContain('D');
  });

  it('applies number notation', async () => {
    await exportSongPdf(song('{key: G}\n[G]a [C]b\n'), { ...opts, nashville: true });
    const text = textOf(await lastPdf());
    expect(text).toContain('1');
    expect(text).toContain('4');
  });

  it('reports characters no font can draw', async () => {
    const missing = await exportSongPdf(song('{key: G}\n[G]안녕하세요\n'), opts);
    expect(missing.length).toBeGreaterThan(0);
  });

  it('reports nothing for a plain English song', async () => {
    expect(await exportSongPdf(song('{key: G}\n[G]hello\n'), opts)).toEqual([]);
  });
});

const entry = (n: number, over: Partial<SetlistEntry> = {}): SetlistEntry => ({
  entry_id: n,
  song_id: n,
  title: `Song ${n}`,
  artist: 'A',
  content: `{title: Song ${n}}\n{key: G}\n[G]la la la\n`,
  content_override: null,
  transpose: 0,
  nashville: 0,
  font: null,
  two_col: null,
  bpm: null,
  youtube_url: null,
  language: 'en',
  ...over,
});

const setlist = (entries: SetlistEntry[]): Setlist => ({
  id: 1,
  name: 'Sunday',
  visibility: 'private',
  event_date: null,
  entries,
});

// pdf-lib writes compressed object streams, so count pages by reloading it
const pageCount = async (bytes: Uint8Array) =>
  (await PDFDocument.load(bytes)).getPageCount();

describe('exportSetlistPdf', () => {
  it('merges one page per song', async () => {
    await exportSetlistPdf(setlist([entry(1), entry(2), entry(3)]), { nashville: false, fontSize: 0 });
    expect(await pageCount(await lastPdf())).toBe(3);
  });

  it('skips private placeholders', async () => {
    const entries = [entry(1), entry(2, { is_private_placeholder: true }), entry(3)];
    await exportSetlistPdf(setlist(entries), { nashville: false, fontSize: 0 });
    expect(await pageCount(await lastPdf())).toBe(2);
  });

  it('rejects a setlist with nothing exportable', async () => {
    await expect(
      exportSetlistPdf(setlist([entry(1, { is_private_placeholder: true })]), {
        nashville: false,
        fontSize: 0,
      }),
    ).rejects.toThrow('No exportable songs');
  });

  it('applies per-entry transpose', async () => {
    await exportSetlistPdf(setlist([entry(1, { transpose: 2 })]), { nashville: false, fontSize: 0 });
    expect(textOf(await lastPdf())).toContain('A');
  });

  it('prefers content_override over the song content', async () => {
    const over = { content_override: '{title: Song 1}\n{key: C}\n[C]overridden words\n' };
    await exportSetlistPdf(setlist([entry(1, over)]), { nashville: false, fontSize: 0 });
    expect(textOf(await lastPdf())).toContain('overridden');
  });

  it('gathers undrawable characters from every entry', async () => {
    const entries = [entry(1), entry(2, { content: '{key: G}\n[G]안녕\n' })];
    const missing = await exportSetlistPdf(setlist(entries), { nashville: false, fontSize: 0 });
    expect(missing.length).toBeGreaterThan(0);
  });
});

const librarySong = (id: number, title: string, content?: string): ExportableSong => ({
  id,
  title,
  artist: 'Artist',
  content: content ?? `{title: ${title}}\n{artist: Artist}\n{key: G}\n[G]lyrics\n`,
  bpm: null,
});

describe('exportLibraryPdf', () => {
  it('rejects a library with no exportable songs', async () => {
    await expect(exportLibraryPdf([])).rejects.toThrow('No exportable songs in your library');
  });

  it('adds a contents page before alphabetically ordered songs', async () => {
    const songs = [
      librarySong(2, 'zebra'),
      librarySong(1, 'Alpha'),
    ];
    expect(orderExportableSongs(songs).map((song) => song.title)).toEqual(['Alpha', 'zebra']);
    await exportLibraryPdf(songs);
    const bytes = await lastPdf();
    expect(await pageCount(bytes)).toBe(3);
    expect(librarySongPageNumbers([1, 1])).toEqual([2, 3]);
  });

  it('accounts for multiple contents pages in song page references', async () => {
    const songs = Array.from({ length: 39 }, (_, i) => librarySong(i, `中文${String(i).padStart(2, '0')}`));
    await exportLibraryPdf(songs);
    const bytes = await lastPdf();
    expect(await pageCount(bytes)).toBe(41);
    expect(librarySongPageNumbers(Array(39).fill(1))).toEqual(
      Array.from({ length: 39 }, (_, i) => i + 3),
    );
  });

  it('keeps a multi-page song together and points the following song after it', async () => {
    const longContent = `{title: 中文長歌}\n{key: G}\n${Array.from({ length: 180 }, (_, i) => `[G]line ${i}`).join('\n')}`;
    await exportLibraryPdf([
      librarySong(1, '中文長歌', longContent),
      librarySong(2, '中文末歌'),
    ]);
    const bytes = await lastPdf();
    const count = await pageCount(bytes);
    expect(count).toBeGreaterThan(3);
    expect(librarySongPageNumbers([count - 2, 1])).toEqual([2, count]);
  });

  it('reports unsupported characters from all songs', async () => {
    const missing = await exportLibraryPdf([librarySong(1, 'Korean', '{title: Korean}\n[G]안녕')]);
    expect(missing.length).toBeGreaterThan(0);
  });
});
