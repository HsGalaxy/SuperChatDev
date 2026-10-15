// Read-only approximate match guidance, never used to authorize an edit.
// Bound output and CPU: candidates come from literal tokens and are scored
// with compact character bigrams; no untrusted regexes or edit side effects.
function bigrams(value) {
  const chars = [...value.toLocaleLowerCase()];
  const set = new Set();
  for (let i = 0; i + 1 < chars.length; i++) set.add(chars[i] + chars[i + 1]);
  return set;
}
function similarity(a, b) {
  if (a === b) return 1;
  const x = bigrams(a), y = bigrams(b);
  if (!x.size || !y.size) return 0;
  let common = 0;
  for (const item of x) if (y.has(item)) common++;
  return 2 * common / (x.size + y.size);
}
function characterDiff(expected, actual) {
  let left = 0;
  while (left < expected.length && left < actual.length && expected[left] === actual[left]) left++;
  let right = 0;
  while (right < expected.length - left && right < actual.length - left &&
         expected[expected.length - 1 - right] === actual[actual.length - 1 - right]) right++;
  const suffix = right ? actual.slice(-right) : '';
  return (actual.slice(0, left) + '{-' + expected.slice(left, right ? -right : undefined) +
    '-}{+' + actual.slice(left, right ? -right : undefined) + '+}' + suffix).slice(0, 650);
}
export function editSuggestions(content, requested, maxItems = 3) {
  if (typeof content !== 'string' || typeof requested !== 'string' || !requested) return [];
  const sample = requested.slice(0, 360).trim();
  if (!sample) return [];
  const tokens = [...new Set(sample.match(/[\p{L}\p{N}_]{3,}/gu) || [])]
    .sort((a, b) => b.length - a.length).slice(0, 6);
  const candidates = new Map();
  // Candidate line numbers are resolved with a single forward scan below.
  // Never allocate one index entry per newline in an untrusted 8 MiB file.
  const folded=content.toLocaleLowerCase();
  for (const token of tokens) {
    if (token.length > 80) continue;
    let at = -1, hits = 0;
    while (hits++ < 80 && (at = folded.indexOf(token.toLocaleLowerCase(), at + 1)) !== -1) {
      const begin = content.lastIndexOf('\n', at - 1) + 1;
      const end = content.indexOf('\n', at);
      const lineEnd = end === -1 ? content.length : end;
      const text = content.slice(begin, Math.min(lineEnd, begin + 450)).replace(/\r$/, '');
      if (!candidates.has(begin)) candidates.set(begin, { text });
      if (candidates.size >= 120) break;
    }
    if (candidates.size >= 120) break;
  }
  if (!candidates.size) {
    const head = content.split('\n', 120).slice(0, 120);
    let offset=0;
    for (const line of head) {
      if (line.trim()) candidates.set(offset, { text: line.slice(0, 450) });
      offset+=line.length+1;
    }
  }
  let cursor=0,line=1;
  for(const [start,item] of [...candidates.entries()].sort((a,b)=>a[0]-b[0])){
    for(let index=content.indexOf('\n',cursor);index!==-1&&index<start;index=content.indexOf('\n',cursor)){
      line++;cursor=index+1;
    }
    item.line=line;
  }
  const target = sample.split('\n').find(s => s.trim())?.slice(0, 450) ?? sample;
  return [...candidates.values()]
    .map(item => ({ ...item, similarity: Math.round(similarity(target, item.text) * 100) }))
    .filter(item => item.similarity >= 25)
    .sort((a, b) => b.similarity - a.similarity || a.line - b.line)
    .slice(0, Math.max(1, Math.min(3, maxItems)))
    .map(item => ({
      line: item.line,
      similarity_percent: item.similarity,
      actual: item.text.slice(0, 350),
      difference: characterDiff(target, item.text)
    }));
}
