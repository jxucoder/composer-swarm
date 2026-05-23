export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const character of String(raw ?? "")) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }
    if (character === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }

  if (escaping) {
    current += "\\";
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

export function normalizeArgv(args) {
  const cleaned = args.filter((arg) => arg && String(arg).trim());
  if (cleaned.length === 1 && /\s/.test(cleaned[0])) {
    return splitRawArgumentString(cleaned[0]);
  }
  return cleaned;
}

export function normalizePluginArgv(args) {
  const cleaned = args.filter((arg) => arg && String(arg).trim());
  if (cleaned.length === 0) {
    return [];
  }
  if (/\s/.test(cleaned[0])) {
    return [...splitRawArgumentString(cleaned[0]), ...cleaned.slice(1)];
  }
  return cleaned;
}

export function normalizeArgs(args) {
  return normalizeArgv(args);
}
