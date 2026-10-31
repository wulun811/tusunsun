const TOKEN_RE = /[a-zA-Z_][a-zA-Z0-9_./-]{1,}/g

export function tokenize(source) {
  const tokens = []
  let m
  while ((m = TOKEN_RE.exec(source)) !== null) {
    const t = m[0]
    if (t.includes('//') || t.includes('/*')) continue
    if (t.length <= 64) tokens.push(t)
  }
  return tokens
}
