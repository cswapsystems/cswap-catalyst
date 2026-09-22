export function scanOutputs<Input, Output>(inputs: Input[], decode: (input: Input) => Output | null) {
  const items: Output[] = [];
  let skipped = 0;
  for (const input of inputs) {
    try { const item = decode(input); if (item !== null) items.push(item); }
    catch { skipped++; }
  }
  return { items, skipped };
}
