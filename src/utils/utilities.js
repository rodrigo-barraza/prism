// ─────────────────────────────────────────────────────────────
// Shared Utilities — General-purpose helpers
// ─────────────────────────────────────────────────────────────


/**
 * Parse JSON from an LLM response, handling markdown code blocks.
 * Many LLMs wrap JSON in ```json ... ``` — this strips that before parsing.
 *
 * @param {string} text - Raw LLM response text
 * @returns {object|Array|null} Parsed JSON, or null if parsing fails
 */
export function parseJsonFromLlmResponse(text) {
  if (!text) return null;
  let jsonText = text.trim();
  const jsonMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) jsonText = jsonMatch[1].trim();
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

