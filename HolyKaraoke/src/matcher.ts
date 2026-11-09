// Convierte un texto en una lista de palabras simples:
// "¡Canta, Corazón!" -> ["canta", "corazon"]
export function toWords(text: string): string[] {
  return text
    .replace(/\[unk\]/gi, " ")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // quita acentos
    .replace(/[^a-zñ0-9\s]/g, " ") // quita signos de puntuación
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

// Cuántas letras hay que cambiar para convertir una palabra en otra
function lettersToChange(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      previous = temp;
    }
  }
  return row[b.length];
}

// Dos palabras "se parecen" si comparten al menos el 75% de sus letras.
function looksAlike(a: string, b: string): boolean {
  const longest = Math.max(a.length, b.length);
  return 1 - lettersToChange(a, b) / longest >= 0.75;
}

// ¿Alguno de estos versos tiene una palabra parecida a esta?
function hasWord(verses: string[], word: string): boolean {
  return toWords(verses.join(" ")).some((verseWord) => looksAlike(word, verseWord));
}

// Cuántas de las palabras escuchadas están en la estrofa, una tras otra,
// contando desde la más nueva hacia atrás.
function wordsInARow(heardWords: string[], stanza: string[]): number {
  let count = 0;
  for (let i = heardWords.length - 1; i >= 0; i--) {
    if (!hasWord(stanza, heardWords[i])) break;
    count++;
  }
  return count;
}

// Versión agresiva: cambia con 1 sola palabra clara de otra estrofa
const MIN_WORDS = 2;

export function findCurrentWord(
  heard: string[],
  stanza: string[],
  current = -1
): number {
  const words = toWords(stanza.join(" "));
  let best = current;
  let bestCount = 0;
  let bestDistance = Infinity;

  for (let index = 0; index < words.length; index++) {
    let count = 0;
    while (count <= index && count < heard.length
      && looksAlike(heard[heard.length - 1 - count], words[index - count])) {
      count++;
    }
    const distance = index >= current ? index - current : words.length + current - index;
    if (count > bestCount || (count > 0 && count === bestCount && distance < bestDistance)) {
      best = index;
      bestCount = count;
      bestDistance = distance;
    }
  }

  return best;
}

export function findBestStanza(
  heard: string[],
  stanzas: string[][],
  current: number
): number {
  const wholeSong = stanzas.flat();
  const heardWords = heard.filter(
    (word) => word.length >= 3 && hasWord(wholeSong, word)
  );

  if (heardWords.length === 0) return current;

  // Si la última palabra todavía pertenece a la estrofa actual, nos quedamos
  const last = heardWords[heardWords.length - 1];
  if (hasWord(stanzas[current], last)) return current;

  // Buscamos la estrofa que más palabras recientes tenga en secuencia
  // Empezamos por la siguiente para respetar el orden de la canción
  let best = current;
  let bestCount = 0;

  for (let step = 1; step < stanzas.length; step++) {
    const index = (current + step) % stanzas.length;
    const count = wordsInARow(heardWords, stanzas[index]);
    if (count > bestCount) {
      best = index;
      bestCount = count;
    }
  }

  return bestCount >= MIN_WORDS ? best : current;
}