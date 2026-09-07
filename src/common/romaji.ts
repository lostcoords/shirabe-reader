import syllables from "./resources/romaji.json";

const kanaBySyllable: Readonly<Record<string, string>> = syllables;
const vowels = "aiueo";
const space = /\p{White_Space}/u;

function hiragana(text: string): string {
  const source = text.toLowerCase();
  let output = "";
  for (let i = 0; i < source.length;) {
    const char = source[i]!;
    const next = source[i + 1] ?? "";
    if (/[a-z]/.test(char) && !vowels.includes(char) && char !== "n"
      && (next === char || char === "t" && next === "c" && source[i + 2] === "h")) {
      output += "っ";
      i += 1;
      continue;
    }
    if (char === "n" && !(next && vowels.includes(next)) && next !== "y") {
      output += "ん";
      i += next === "'" ? 2 : 1;
      continue;
    }
    const size = [3, 2, 1].find((length) => kanaBySyllable[source.slice(i, i + length)]);
    output += size ? kanaBySyllable[source.slice(i, i + size)] : char;
    i += size ?? 1;
  }
  return output;
}

export function searchReadings(text: string): string[] {
  const source = text.normalize("NFKC").trim();
  const parts = source.split(/\p{White_Space}+/u);
  if (!source || parts.some((part) => !/^[a-z][a-z'-]*$/i.test(part) || !/^[\p{Script=Hiragana}ー]+$/u.test(hiragana(part)))) return [];
  const reading = hiragana(source);
  const compact = [...reading].filter((char) => !space.test(char)).join("");
  const spellings = [reading, compact].flatMap((variant) =>
    [variant, variant.replace(/でわ(?=(?:ない|なかった|ありません(?:でした)?)$)/u, "では")]);
  return [...new Set(spellings.flatMap((variant) => {
    const katakana = variant.replace(/[ぁ-ゖ]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 0x60));
    return [variant, katakana];
  }))];
}
