import guitarData from '@tombatossals/chords-db/lib/guitar.json';
import type { Barre, Chord, Finger } from 'svguitar';

interface DbPosition {
  frets: number[];
  fingers: number[];
  baseFret: number;
  barres: number[];
}

interface DbChord {
  key: string;
  suffix: string;
  positions: DbPosition[];
}

interface GuitarDatabase {
  chords: Record<string, DbChord[]>;
}

const database = guitarData as GuitarDatabase;
const DATABASE_ROOTS: Record<string, string> = { 'Db': 'C#', 'D#': 'Eb', 'Gb': 'F#', 'G#': 'Ab', 'A#': 'Bb' };

function parseSymbol(symbol: string): { root: string; suffix: string } | null {
  const match = symbol.match(/^([A-G][b#]?)(.*)$/);
  if (!match) return null;
  const root = DATABASE_ROOTS[match[1]] || match[1];
  const rawSuffix = match[2];
  const suffix = rawSuffix === '' ? 'major' : rawSuffix === 'm' ? 'minor' : rawSuffix;
  return { root, suffix };
}

export function guitarChordDiagram(symbol: string): Chord | null {
  const parsed = parseSymbol(symbol);
  if (!parsed) return null;
  const entry = database.chords[parsed.root]?.find((chord) => chord.suffix === parsed.suffix);
  const position = entry?.positions[0];
  if (!position) return null;

  const fingers: Finger[] = position.frets.map((fret, index) => {
    const string = 6 - index;
    if (fret < 0) return [string, 'x'];
    if (fret === 0) return [string, 0];
    const finger = position.fingers[index];
    return [string, fret, finger ? String(finger) : undefined];
  });

  const frettedStrings = (fret: number) => position.frets
    .map((value, index) => ({ value, string: 6 - index }))
    .filter(({ value }) => value === fret)
    .map(({ string }) => string);
  const barres: Barre[] = position.barres.flatMap((fret) => {
    const strings = frettedStrings(fret);
    return strings.length > 1
      ? [{ fromString: Math.max(...strings), toString: Math.min(...strings), fret }]
      : [];
  });

  return { fingers, barres, position: position.baseFret, title: symbol };
}
