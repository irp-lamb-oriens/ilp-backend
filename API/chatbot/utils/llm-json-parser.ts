/**
 * ILP — Legal Assistant LLM JSON extractor.
 * Priority: --- fence > ``` fence > outermost [ ] or { }
 */

export function extractJSONFromLLMResponse(raw: string): string {
  const dashFence = raw.match(/---\s*([\s\S]+?)\s*---/);
  if (dashFence) return dashFence[1].trim();

  const tickFence = raw.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (tickFence) return tickFence[1].trim();

  const firstBracket = raw.indexOf("[");
  const lastBracket = raw.lastIndexOf("]");
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");

  if (firstBracket !== -1 && lastBracket > firstBracket) {
    if (firstBrace === -1 || firstBracket < firstBrace) {
      return raw.substring(firstBracket, lastBracket + 1);
    }
  }

  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return raw.substring(firstBrace, lastBrace + 1);
  }

  return raw.trim();
}