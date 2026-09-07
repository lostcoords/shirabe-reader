export type IntentExpectation = {
  surface: string;
  lemma?: string;
  reading?: string | string[];
  inflection?: string[];
  inflectionBase?: string;
  leaders: string[];
  offers?: string[];
  excludes?: string[];
};

export type IntentToken = { surface: string; lemma?: string; reading?: string | null; inflection?: string[]; inflectionBase?: string | null; entry: string | null; candidates: string[] };

export type StudyIdentity = { headword: string; readings: string[] };

export function studyIdentityErrors(headword: string | undefined, reading: string | null | undefined, expected: StudyIdentity | undefined): string[] {
  if (!expected) return ["missing study identity reference"];
  const errors: string[] = [];
  if (headword !== expected.headword) errors.push(`unexpected study headword ${headword}`);
  if (expected.readings.length && !expected.readings.some((candidate) => normalizedReading(candidate) === normalizedReading(reading))) {
    errors.push(`unexpected study reading ${reading}`);
  }
  return errors;
}

const normalizedReading = (reading: string | null | undefined): string | undefined =>
  reading?.normalize("NFKC").replace(/[ァ-ヶ]/g, (kana) => String.fromCharCode(kana.charCodeAt(0) - 0x60));

export function readingsAgree(left: IntentToken[], right: IntentToken[]): boolean {
  return left.length === right.length && left.every((token, index) => {
    const other = right[index]!;
    return (!token.entry && !other.entry) || normalizedReading(token.reading) === normalizedReading(other.reading);
  });
}

export function inflectionsAgree(left: IntentToken[], right: IntentToken[]): boolean {
  return left.length === right.length && left.every((token, index) =>
    JSON.stringify(token.inflection ?? []) === JSON.stringify(right[index]!.inflection ?? [])
    && (token.inflectionBase ?? null) === (right[index]!.inflectionBase ?? null));
}

export function intentErrors(tokens: IntentToken[], expectations: IntentExpectation[]): string[] {
  const duplicateErrors = tokens.flatMap(({ surface, candidates }) => {
    const duplicates = candidates.filter((entry, index) => candidates.indexOf(entry) !== index);
    return [...new Set(duplicates)].map((entry) => `${surface}: duplicate alternative ${entry}`);
  });
  return duplicateErrors.concat(expectations.flatMap((expected) => {
    const matching = tokens.filter((token) => token.surface === expected.surface);
    if (!matching.length) return [`Missing whole token ${expected.surface}`];
    return matching.flatMap((token) => {
      const errors: string[] = [];
      const readings = expected.reading === undefined ? undefined
        : Array.isArray(expected.reading) ? expected.reading : [expected.reading];
      if (readings && !readings.some((reading) => normalizedReading(token.reading) === normalizedReading(reading))) {
        errors.push(`${token.surface}: unexpected reading ${token.reading}`);
      }
      if (expected.inflectionBase !== undefined && token.inflectionBase !== expected.inflectionBase) {
        errors.push(`${token.surface}: unexpected inflection base ${token.inflectionBase}`);
      }
      if (expected.inflection !== undefined && JSON.stringify(token.inflection ?? []) !== JSON.stringify(expected.inflection)) {
        errors.push(`${token.surface}: unexpected inflection ${JSON.stringify(token.inflection ?? [])}`);
      }
      if (expected.lemma !== undefined && token.lemma !== expected.lemma) {
        errors.push(`${token.surface}: unexpected lemma ${token.lemma}`);
      }
      if (!token.entry || !expected.leaders.includes(token.entry)) {
        errors.push(`${token.surface}: unexpected leader ${token.entry}`);
      }
      const available = new Set([token.entry, ...token.candidates]);
      for (const entry of expected.offers ?? []) {
        if (!available.has(entry)) errors.push(`${token.surface}: missing alternative ${entry}`);
      }
      for (const entry of expected.excludes ?? []) {
        if (available.has(entry)) errors.push(`${token.surface}: context excludes ${entry}`);
      }
      return errors;
    });
  }));
}
